import { callable, definePlugin, toaster } from "@decky/api";
import { ButtonItem, DropdownItem, PanelSection, PanelSectionRow, TextField, ToggleField } from "@decky/ui";
import { useEffect, useState } from "react";
import { FaCloudUploadAlt } from "react-icons/fa";
import { ClipSummary, exportClip, gameName, onClipSaved, withRequestedClip } from "./clips";
import { ShareTarget, patchShareMenu, screenshotPath } from "./shareMenu";

const getConfig = callable<[], PluginConfig>("get_config");
const login = callable<[string, string, string], Result>("login");
const logout = callable<[], boolean>("logout");
const listAlbums = callable<[], Result & { albums?: Album[] }>("list_albums");
const setAlbum = callable<[string], boolean>("set_album");
const manualUpload = callable<[string, string], Result>("manual_upload");
const uploadVideo = callable<[string, string, string, number], Result>("upload_video");
const setAutoUpload = callable<["screenshots" | "clips", boolean], void>("set_auto_upload");

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
  auto_upload?: boolean;
  auto_upload_clips?: boolean;
  uploader?: {
    url?: string;
    api_key?: string;
    email?: string;
    album_id?: string;
  };
};

const PLACEHOLDER_URL = "https://YOUR_IMMICH_URL/api";

// Read by the saved-clip listener, which runs outside the panel.
const autoUploadClips = { enabled: false };

function updateAutoUploadClips(config: PluginConfig) {
  autoUploadClips.enabled = config.auto_upload_clips ?? false;
}

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
  const [screenshots, setScreenshots] = useState((config.enabled ?? true) && (config.auto_upload ?? true));
  const [clips, setClips] = useState(config.auto_upload_clips ?? false);
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

  const toggleScreenshots = async (checked: boolean) => {
    setScreenshots(checked);
    await setAutoUpload("screenshots", checked);
  };

  const toggleClips = async (checked: boolean) => {
    setClips(checked);
    updateAutoUploadClips({ auto_upload_clips: checked });
    await setAutoUpload("clips", checked);
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
      <PanelSection title="Upload Automatically">
        <PanelSectionRow>
          <ToggleField label="Screenshots" checked={screenshots} onChange={toggleScreenshots} />
        </PanelSectionRow>
        <PanelSectionRow>
          <ToggleField label="Clips" checked={clips} onChange={toggleClips} />
        </PanelSectionRow>
        <PanelSectionRow>
          <div style={{ fontSize: "12px", opacity: 0.7 }}>
            You can manually upload screenshots and clips by choosing Share in Media.
          </div>
        </PanelSectionRow>
      </PanelSection>
      <PanelSection>
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

async function uploadClip(summary: ClipSummary, exportedPath?: string): Promise<Result> {
  const path = exportedPath ?? (await exportClip(summary.clip_id));
  return uploadVideo(path, summary.clip_id, gameName(summary.game_id), summary.date_recorded);
}

function describe(screenshots: number, clips: number): string {
  const parts = [];
  if (screenshots > 0) parts.push(screenshots === 1 ? "screenshot" : `${screenshots} screenshots`);
  if (clips > 0) parts.push(clips === 1 ? "clip" : `${clips} clips`);
  return parts.join(" and ");
}

async function uploadShareTarget(target: ShareTarget) {
  const clipCount = target.clips.length + (target.clipRequest ? 1 : 0);
  const what = describe(target.screenshots.length, clipCount);
  const total = target.screenshots.length + clipCount;
  toaster.toast({ title: "Immich", body: `Uploading ${what}...` });

  const uploads: (() => Promise<Result>)[] = [
    ...target.screenshots.map((screenshot) => async () => {
      const { strGameID } = screenshot.local!;
      return manualUpload(await screenshotPath(screenshot), gameName(strGameID));
    }),
    ...target.clips.map((summary) => () => uploadClip(summary)),
  ];
  if (target.clipRequest) {
    const request = target.clipRequest;
    uploads.push(async () => {
      // The share sheet's clip only exists until cleanup, so export it before letting go.
      const { summary, path } = await withRequestedClip(request, async (summary) => ({
        summary,
        path: await exportClip(summary.clip_id),
      }));
      return uploadClip(summary, path);
    });
  }

  let failed = 0;
  let lastError = "";
  for (const upload of uploads) {
    try {
      const result = await upload();
      if (!result.success) {
        failed += 1;
        lastError = result.error ?? "";
      }
    } catch (err) {
      failed += 1;
      lastError = err instanceof Error ? err.message : String(err);
    }
  }

  if (failed === 0) {
    const done = what.charAt(0).toUpperCase() + what.slice(1);
    toaster.toast({ title: "Immich", body: total === 1 ? `${done} uploaded.` : `Uploaded ${what}.` });
  } else {
    toaster.toast({ title: "Immich Upload Failed", body: lastError || `${failed} of ${total} failed.` });
  }
}

async function autoUploadClip(summary: ClipSummary) {
  if (!autoUploadClips.enabled) {
    return;
  }
  try {
    const result = await uploadClip(summary);
    if (!result.success) {
      console.warn("[immichuploader] video upload failed, will retry", result.error);
    }
  } catch (err) {
    console.error("[immichuploader] could not upload video", err);
  }
}

export default definePlugin(() => {
  const unpatchShareMenu = patchShareMenu(uploadShareTarget);
  const stopWatchingClips = onClipSaved(autoUploadClip);
  getConfig().then(updateAutoUploadClips);

  return {
    name: "Immich Uploader",
    icon: <FaCloudUploadAlt />,
    content: <Content />,
    titleView: <div>Immich Uploader</div>,
    onDismount() {
      unpatchShareMenu();
      stopWatchingClips();
    },
  };
});
