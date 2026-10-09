import { callable, definePlugin, toaster } from "@decky/api";
import { ButtonItem, DropdownItem, PanelSection, PanelSectionRow, TextField, ToggleField } from "@decky/ui";
import { useEffect, useState } from "react";
import { FaCloudUploadAlt } from "react-icons/fa";
import { patchShareMenu, screenshotGameName, screenshotPath } from "./shareMenu";

const getConfig = callable<[], PluginConfig>("get_config");
const setEnabled = callable<[boolean], void>("set_enabled");
const login = callable<[string, string, string], Result>("login");
const logout = callable<[], boolean>("logout");
const listAlbums = callable<[], Result & { albums?: Album[] }>("list_albums");
const setAlbum = callable<[string], boolean>("set_album");
const manualUpload = callable<[string, string], Result>("manual_upload");

type Result = {
  success: boolean;
  error?: string;
};

type Album = {
  id: string;
  name: string;
};

type PluginConfig = {
  enabled?: boolean;
  uploader?: {
    url?: string;
    api_key?: string;
    email?: string;
    album_id?: string;
  };
};

const PLACEHOLDER_URL = "https://YOUR_IMMICH_URL/api";

function LoginForm({ initialUrl, onLoggedIn }: { initialUrl: string; onLoggedIn: () => void }) {
  const [url, setUrl] = useState(initialUrl);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const logIn = async () => {
    setBusy(true);
    setError("");
    try {
      const result = await login(url, email, password);
      if (result.success) {
        onLoggedIn();
      } else {
        setError(result.error ?? "Login failed.");
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <PanelSection title="Log In to Immich">
      <PanelSectionRow>
        <TextField label="Immich URL" value={url} disabled={busy} onChange={(e) => setUrl(e.target.value)} />
      </PanelSectionRow>
      <PanelSectionRow>
        <TextField label="Email" value={email} disabled={busy} onChange={(e) => setEmail(e.target.value)} />
      </PanelSectionRow>
      <PanelSectionRow>
        <TextField
          label="Password"
          value={password}
          disabled={busy}
          // The Steam client ignores bIsPassword; its own login screen masks input with type="password".
          {...{ type: "password" }}
          onChange={(e) => setPassword(e.target.value)}
        />
      </PanelSectionRow>
      {error && (
        <PanelSectionRow>
          <div style={{ color: "#ff6b6b", fontSize: "12px" }}>{error}</div>
        </PanelSectionRow>
      )}
      <PanelSectionRow>
        <ButtonItem layout="below" disabled={busy || !url.trim() || !email.trim() || !password} onClick={logIn}>
          {busy ? "Logging In..." : "Log In"}
        </ButtonItem>
      </PanelSectionRow>
    </PanelSection>
  );
}

function AccountPanel({ config, onLoggedOut }: { config: PluginConfig; onLoggedOut: () => void }) {
  const [enabled, setEnabledState] = useState(config.enabled ?? true);
  const [albumId, setAlbumId] = useState(config.uploader?.album_id ?? "");
  const [albums, setAlbums] = useState<Album[] | null>(null);
  const [albumError, setAlbumError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    listAlbums()
      .then((result) => {
        if (result.success) {
          setAlbums(result.albums ?? []);
        } else {
          setAlbumError(result.error ?? "Could not load albums.");
        }
      })
      .catch((err) => setAlbumError(String(err)));
  }, []);

  const toggleEnabled = async (checked: boolean) => {
    setEnabledState(checked);
    await setEnabled(checked);
  };

  const chooseAlbum = async (id: string) => {
    setAlbumId(id);
    await setAlbum(id);
  };

  const logOut = async () => {
    setBusy(true);
    try {
      await logout();
      onLoggedOut();
    } finally {
      setBusy(false);
    }
  };

  const albumOptions = [{ data: "", label: "None" }, ...(albums ?? []).map((a) => ({ data: a.id, label: a.name }))];

  return (
    <>
      <PanelSection>
        <PanelSectionRow>
          <ToggleField
            label="Upload Automatically"
            description="Upload new screenshots as soon as they're taken."
            checked={enabled}
            onChange={toggleEnabled}
          />
        </PanelSectionRow>
        <PanelSectionRow>
          <DropdownItem
            label="Album"
            description={albumError || undefined}
            disabled={albums === null}
            rgOptions={albumOptions}
            selectedOption={albumId}
            onChange={(option) => chooseAlbum(option.data)}
          />
        </PanelSectionRow>
      </PanelSection>
      <PanelSection title="Account">
        <PanelSectionRow>
          <div style={{ fontSize: "12px", wordBreak: "break-all" }}>
            <div>{config.uploader?.email ?? "Logged in"}</div>
            <div style={{ opacity: 0.7 }}>{config.uploader?.url}</div>
          </div>
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem layout="below" disabled={busy} onClick={logOut}>
            Log Out
          </ButtonItem>
        </PanelSectionRow>
      </PanelSection>
    </>
  );
}

function Content() {
  const [config, setConfig] = useState<PluginConfig | null>(null);

  const reload = () => {
    getConfig().then(setConfig);
  };

  useEffect(reload, []);

  if (!config) {
    return null;
  }

  if (!config.uploader?.api_key) {
    const url = config.uploader?.url;
    return <LoginForm initialUrl={url && url !== PLACEHOLDER_URL ? url : ""} onLoggedIn={reload} />;
  }

  return <AccountPanel config={config} onLoggedOut={reload} />;
}

async function uploadScreenshots(screenshots: Parameters<typeof screenshotPath>[0][]) {
  const count = screenshots.length;
  toaster.toast({ title: "Immich", body: count === 1 ? "Uploading screenshot..." : `Uploading ${count} screenshots...` });

  let failed = 0;
  let lastError = "";
  for (const screenshot of screenshots) {
    try {
      const result = await manualUpload(await screenshotPath(screenshot), screenshotGameName(screenshot));
      if (!result.success) {
        failed += 1;
        lastError = result.error ?? "";
      }
    } catch (err) {
      failed += 1;
      lastError = String(err);
    }
  }

  if (failed === 0) {
    toaster.toast({ title: "Immich", body: count === 1 ? "Screenshot uploaded." : `Uploaded ${count} screenshots.` });
  } else {
    toaster.toast({ title: "Immich Upload Failed", body: lastError || `${failed} of ${count} failed.` });
  }
}

export default definePlugin(() => {
  const unpatchShareMenu = patchShareMenu(uploadScreenshots);

  return {
    name: "Immich Uploader",
    icon: <FaCloudUploadAlt />,
    content: <Content />,
    titleView: <div>Immich Uploader</div>,
    onDismount: unpatchShareMenu,
  };
});
