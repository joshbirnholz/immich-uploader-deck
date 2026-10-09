import asyncio
import os
import pathlib
import logging
import shutil
import subprocess
import sys
import glob
import json
import ssl
import urllib.error
import urllib.request

PLUGIN_DIR = pathlib.Path(__file__).parent.resolve()
CONFIG_DIR = pathlib.Path("/home/deck/.config/immichuploader")
CONFIG_FILE = CONFIG_DIR / "immichuploader.yml"
SCREENSHOTS_BASE = pathlib.Path("/home/deck/.local/share/Steam/userdata")
SYSTEM_CA_BUNDLE = pathlib.Path("/etc/ssl/certs/ca-certificates.crt")

sys.path.insert(0, str(PLUGIN_DIR / "py_modules"))

import yaml


def log(message):
    logging.info(f"[immichuploader] {message}")


def normalize_api_url(url):
    """Immich serves its API under /api; accept the plain server URL too."""
    url = url.strip().rstrip("/")
    if url and not url.endswith("/api"):
        url += "/api"
    return url


def ssl_context():
    """Decky's bundled Python has no CA certificates, so trust the system bundle."""
    context = ssl.create_default_context()
    if SYSTEM_CA_BUNDLE.exists():
        context.load_verify_locations(cafile=str(SYSTEM_CA_BUNDLE))
    return context


def immich_request(url, path, body=None, token=None):
    """Send a JSON request to the Immich API and return the decoded response."""
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"

    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(f"{url}{path}", data=data, headers=headers, method="POST")

    with urllib.request.urlopen(request, timeout=15, context=ssl_context()) as response:
        content = response.read()
        return json.loads(content) if content else {}


def create_api_key(url, email, password):
    """Log in with email/password, mint an upload-scoped API key, then log out."""
    session = immich_request(url, "/auth/login", {"email": email, "password": password})
    token = session["accessToken"]

    try:
        try:
            created = immich_request(
                url, "/api-keys", {"name": "Steam Deck", "permissions": ["asset.upload"]}, token
            )
        except urllib.error.HTTPError as exc:
            # Older Immich versions don't accept the permissions field.
            if exc.code != 400:
                raise
            created = immich_request(url, "/api-keys", {"name": "Steam Deck"}, token)
    finally:
        try:
            immich_request(url, "/auth/logout", token=token)
        except Exception as exc:
            log(f"logout after key creation failed: {exc}")

    return created["secret"]


class Plugin:
    process = None

    async def _main(self):
        os.makedirs(CONFIG_DIR, exist_ok=True)

        if not os.path.exists(CONFIG_FILE):
            shutil.copyfile(PLUGIN_DIR / "immichuploader.yml", CONFIG_FILE)
            os.chmod(CONFIG_FILE, 0o0600)

        config = await self.get_config()

        if config and config.get("enabled", True):
            await self.start()

        while True:
            await asyncio.sleep(1)

    async def _unload(self):
        await self.stop()

    async def start(self):
        if not await self.is_running():
            log("starting backend service")
            try:
                self.process = subprocess.Popen(
                    [
                        str(PLUGIN_DIR / "bin" / "immichuploader"),
                        "-c",
                        str(CONFIG_FILE),
                    ],
                    cwd=str(PLUGIN_DIR),
                )
            except Exception as exc:
                log(f"failed to start backend service: {exc}")
                self.process = None

    async def stop(self):
        if await self.is_running():
            log("stopping backend service")
            self.process.terminate()

        self.process = None

    async def toggle(self):
        config = await self.get_config()
        config["enabled"] = not await self.is_running()

        await self.write_config(config)

        if await self.is_running():
            await self.stop()
        else:
            await self.start()

    async def is_running(self):
        if self.process is None:
            return False

        return self.process.poll() is None

    async def get_config(self):
        with open(CONFIG_FILE) as f:
            return yaml.safe_load(f) or {}

    async def set_config(self, config):
        uploader = config.get("uploader") or {}
        if uploader.get("url"):
            uploader["url"] = normalize_api_url(uploader["url"])
        await self.write_config(config)
        return True

    async def login(self, url, email, password):
        """Log in to Immich, store a newly created API key, and restart the backend."""
        url = normalize_api_url(url)
        log(f"logging in to {url} as {email}")
        try:
            api_key = await asyncio.to_thread(create_api_key, url, email.strip(), password)
        except urllib.error.HTTPError as exc:
            if exc.code == 401:
                return {"success": False, "error": "Incorrect email or password."}
            if exc.code == 404:
                return {"success": False, "error": f"No Immich API found at {url}. Check the Immich URL."}
            detail = exc.read().decode(errors="replace")
            log(f"login failed with status {exc.code}: {detail}")
            return {"success": False, "error": f"Immich returned {exc.code}: {detail}"}
        except urllib.error.URLError as exc:
            log(f"login failed: {exc.reason}")
            return {"success": False, "error": f"Could not reach Immich: {exc.reason}"}
        except Exception as exc:
            log(f"login failed: {exc}")
            return {"success": False, "error": str(exc)}

        config = await self.get_config()
        uploader = config.setdefault("uploader", {})
        uploader["kind"] = "Immich"
        uploader["url"] = url
        uploader["api_key"] = api_key
        uploader["email"] = email.strip()
        await self.write_config(config)
        log("login successful, API key stored")

        if await self.is_running():
            await self.stop()
            await self.start()

        return {"success": True}

    async def logout(self):
        """Forget the stored API key and stop the backend."""
        config = await self.get_config()
        uploader = config.setdefault("uploader", {})
        uploader["api_key"] = ""
        uploader.pop("email", None)
        await self.write_config(config)
        await self.stop()
        log("logged out, API key removed")
        return True

    async def write_config(self, config):
        with open(CONFIG_FILE, "w") as fw:
            yaml.safe_dump(config, fw)

    async def list_recent_screenshots(self):
        """Find the 20 most recent screenshots across all Steam users/games."""
        search_path = str(SCREENSHOTS_BASE / "*" / "760" / "remote" / "*" / "screenshots" / "*.jpg")
        files = glob.glob(search_path)
        
        # Filter out thumbnails
        files = [f for f in files if "thumbnail" not in f]
        
        # Sort by mtime descending
        files.sort(key=os.path.getmtime, reverse=True)
        
        # Return last 20 with name and full path
        recent = []
        for f in files[:20]:
            recent.append({
                "name": os.path.basename(f),
                "path": f,
                "mtime": os.path.getmtime(f)
            })
        return recent

    async def manual_upload(self, path):
        """Manually trigger an upload for a specific file."""
        log(f"manually uploading: {path}")
        try:
            res = subprocess.run(
                [
                    str(PLUGIN_DIR / "bin" / "immichuploader"),
                    "-c",
                    str(CONFIG_FILE),
                    "upload",
                    path
                ],
                capture_output=True,
                text=True
            )
            if res.returncode == 0:
                log("manual upload successful")
                return {"success": True}
            else:
                log(f"manual upload failed: {res.stderr}")
                return {"success": False, "error": res.stderr}
        except Exception as e:
            log(f"manual upload error: {str(e)}")
            return {"success": False, "error": str(e)}
