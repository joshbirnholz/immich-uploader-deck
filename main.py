import asyncio
import os
import pathlib
import logging
import shutil
import subprocess
import sys
import json
import ssl
import urllib.error
import urllib.request

PLUGIN_DIR = pathlib.Path(__file__).parent.resolve()
CONFIG_DIR = pathlib.Path("/home/deck/.config/immichuploader")
CONFIG_FILE = CONFIG_DIR / "immichuploader.yml"
BACKEND_PID_FILE = CONFIG_DIR / "backend.pid"
PENDING_VIDEOS_DIR = CONFIG_DIR / "pending-videos"
BACKEND_BINARY = PLUGIN_DIR / "bin" / "immichuploader"
VIDEO_RETRY_SECONDS = 60
SYSTEM_CA_BUNDLE = pathlib.Path("/etc/ssl/certs/ca-certificates.crt")
API_KEY_PERMISSIONS = ["asset.upload", "album.read", "albumAsset.create"]

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


def immich_request(url, path, body=None, token=None, api_key=None, method="POST"):
    """Send a JSON request to the Immich API and return the decoded response."""
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if api_key:
        headers["x-api-key"] = api_key

    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(f"{url}{path}", data=data, headers=headers, method=method)

    with urllib.request.urlopen(request, timeout=15, context=ssl_context()) as response:
        content = response.read()
        return json.loads(content) if content else {}


def create_api_key(url, email, password):
    """Log in with email/password, mint a narrowly scoped API key, then log out."""
    session = immich_request(url, "/auth/login", {"email": email, "password": password})
    token = session["accessToken"]

    try:
        try:
            created = immich_request(
                url, "/api-keys", {"name": "Steam Deck", "permissions": API_KEY_PERMISSIONS}, token
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


def stop_stale_backend():
    """Stop a backend left running by an earlier plugin instance (e.g. after Decky restarts)."""
    try:
        pid = int(BACKEND_PID_FILE.read_text())
        cmdline = pathlib.Path(f"/proc/{pid}/cmdline").read_bytes().split(b"\0")
    except (OSError, ValueError):
        return

    if cmdline and cmdline[0].endswith(b"bin/immichuploader") and b"upload" not in cmdline:
        log(f"stopping stale backend service (pid {pid})")
        os.kill(pid, 15)


class Plugin:
    process = None
    video_lock = None

    async def _main(self):
        os.makedirs(CONFIG_DIR, exist_ok=True)
        os.makedirs(PENDING_VIDEOS_DIR, exist_ok=True)
        self.video_lock = asyncio.Lock()

        if not os.path.exists(CONFIG_FILE):
            shutil.copyfile(PLUGIN_DIR / "immichuploader.yml", CONFIG_FILE)
            os.chmod(CONFIG_FILE, 0o0600)

        stop_stale_backend()
        config = await self.get_config()

        if config and config.get("enabled", True):
            await self.start()

        while True:
            await asyncio.sleep(VIDEO_RETRY_SECONDS)
            await self.retry_pending_videos()

    async def _unload(self):
        await self.stop()

    async def start(self):
        if not await self.is_running():
            log("starting backend service")
            try:
                self.process = subprocess.Popen(
                    [str(BACKEND_BINARY), "-c", str(CONFIG_FILE)],
                    cwd=str(PLUGIN_DIR),
                )
                BACKEND_PID_FILE.write_text(str(self.process.pid))
            except Exception as exc:
                log(f"failed to start backend service: {exc}")
                self.process = None

    async def stop(self):
        if await self.is_running():
            log("stopping backend service")
            self.process.terminate()
            try:
                await asyncio.to_thread(self.process.wait, 5)
            except subprocess.TimeoutExpired:
                self.process.kill()

        self.process = None
        BACKEND_PID_FILE.unlink(missing_ok=True)

    async def restart_if_running(self):
        if await self.is_running():
            await self.stop()
            await self.start()

    async def set_enabled(self, enabled):
        config = await self.get_config()
        config["enabled"] = enabled
        await self.write_config(config)

        if enabled:
            await self.start()
        else:
            await self.stop()

    async def set_auto_upload(self, kind, enabled):
        """Turn automatic uploads of "screenshots" or "videos" on or off."""
        config = await self.get_config()
        if kind == "screenshots":
            config["auto_upload"] = enabled
        else:
            config["auto_upload_videos"] = enabled
        await self.write_config(config)

        if kind == "screenshots":
            await self.restart_if_running()

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

        await self.restart_if_running()
        return {"success": True}

    async def logout(self):
        """Forget the stored API key and stop the backend."""
        config = await self.get_config()
        uploader = config.setdefault("uploader", {})
        uploader["api_key"] = ""
        uploader.pop("email", None)
        uploader.pop("album_id", None)
        await self.write_config(config)
        await self.stop()
        log("logged out, API key removed")
        return True

    async def write_config(self, config):
        with open(CONFIG_FILE, "w") as fw:
            yaml.safe_dump(config, fw)

    async def list_albums(self):
        """Return the user's albums as [{id, name}], sorted by name."""
        uploader = (await self.get_config()).get("uploader") or {}
        try:
            albums = await asyncio.to_thread(
                immich_request, uploader.get("url", ""), "/albums", api_key=uploader.get("api_key"), method="GET"
            )
        except urllib.error.HTTPError as exc:
            if exc.code == 403:
                return {"success": False, "error": "Log out and back in to allow choosing an album."}
            return {"success": False, "error": f"Immich returned {exc.code}."}
        except Exception as exc:
            log(f"listing albums failed: {exc}")
            return {"success": False, "error": str(exc)}

        albums = [{"id": a["id"], "name": a["albumName"]} for a in albums]
        albums.sort(key=lambda a: a["name"].lower())
        return {"success": True, "albums": albums}

    async def set_album(self, album_id):
        config = await self.get_config()
        uploader = config.setdefault("uploader", {})
        if album_id:
            uploader["album_id"] = album_id
        else:
            uploader.pop("album_id", None)
        await self.write_config(config)
        await self.restart_if_running()
        return True

    async def run_upload(self, path, game_name="", captured_at=None):
        """Upload one file with the backend binary and return {success, error}."""
        uploader = (await self.get_config()).get("uploader") or {}
        if not uploader.get("api_key"):
            return {"success": False, "error": "Log in from the Immich Uploader panel first."}

        command = [str(BACKEND_BINARY), "-c", str(CONFIG_FILE), "upload", str(path)]
        if game_name:
            command += ["--game-name", game_name]
        if captured_at:
            command += ["--captured-at", str(int(captured_at))]

        try:
            res = await asyncio.to_thread(subprocess.run, command, capture_output=True, text=True)
        except Exception as exc:
            log(f"upload error: {exc}")
            return {"success": False, "error": str(exc)}

        if res.returncode == 0:
            return {"success": True}

        log(f"upload failed: {res.stderr}")
        lines = [line for line in res.stderr.strip().splitlines() if line.strip()]
        return {"success": False, "error": lines[-1] if lines else "Upload failed."}

    async def manual_upload(self, path, game_name=""):
        """Upload a single screenshot right away, optionally naming the game it's from."""
        log(f"manually uploading: {path}")
        result = await self.run_upload(path, game_name)
        if result["success"]:
            log("manual upload successful")
        return result

    async def upload_video(self, exported_path, clip_id, game_name="", captured_at=None):
        """Upload a clip Steam exported to MP4. Failed uploads are kept and retried later."""
        video = PENDING_VIDEOS_DIR / f"{clip_id}.mp4"
        shutil.move(exported_path, video)
        video.with_suffix(".json").write_text(json.dumps({"game_name": game_name, "captured_at": captured_at}))

        log(f"uploading video: {clip_id}")
        return await self.upload_pending_video(video)

    async def upload_pending_video(self, video):
        async with self.video_lock:
            if not video.exists():
                return {"success": True}

            meta_file = video.with_suffix(".json")
            try:
                meta = json.loads(meta_file.read_text())
            except (OSError, ValueError):
                meta = {}

            result = await self.run_upload(video, meta.get("game_name", ""), meta.get("captured_at"))
            if result["success"]:
                log(f"video uploaded: {video.stem}")
                video.unlink(missing_ok=True)
                meta_file.unlink(missing_ok=True)
            return result

    async def retry_pending_videos(self):
        for video in sorted(PENDING_VIDEOS_DIR.glob("*.mp4")):
            log(f"retrying video upload: {video.stem}")
            await self.upload_pending_video(video)
