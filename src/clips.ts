import { findModuleExport } from "@decky/ui";

// Steam keeps game recordings as streaming segments; its own share sheet turns a clip into an
// MP4 through the game recording store's ExportClip. We use the same store and service.

export type ClipSummary = {
  clip_id: string;
  game_id: string;
  date_recorded: number;
  temporary?: boolean;
};

/** Steam's in-progress clip (e.g. a range picked from a background recording) behind the clip share sheet. */
export type ClipCreationRequest = {
  create(temporary: boolean): Promise<{ result: number; clipSummary?: ClipSummary }>;
  cleanup(): void;
};

type RecordingStore = {
  ExportClip(clipID: string, path: string, settings: object, useUniqueFilename: boolean): Promise<number>;
};

type RecordingService = {
  RegisterForNotifyClipCreated(handler: (message: any) => number): { unregister(): void };
};

const RESULT_OK = 1;
const EXPORT_SUCCESS = 1;

let store: RecordingStore | undefined;
let service: RecordingService | undefined;

function recordingStore(): RecordingStore {
  // Steam creates the store lazily and keeps it on window.g_GRS; it isn't a module export
  // Decky's lookup can see, so the export search is only a fallback.
  store ??=
    (window as any).g_GRS ??
    findModuleExport(
      (e: any) => e && typeof e === "object" && typeof e.ExportClip === "function" && typeof e.GetClipSummary === "function",
    );
  if (!store) {
    throw new Error("Steam's game recording store wasn't found.");
  }
  return store;
}

function recordingService(): RecordingService | undefined {
  service ??= findModuleExport(
    (e: any) => e && typeof e.RegisterForNotifyClipCreated === "function" && typeof e.ExportClip === "function",
  );
  return service;
}

// Steam exports one clip at a time and reports ConverterBusy otherwise, so exports are queued.
let exportQueue: Promise<unknown> = Promise.resolve();

/** Exports a saved clip to a temporary MP4 and returns its path. */
export function exportClip(clipID: string): Promise<string> {
  const run = async () => {
    const path = await SteamClient.System.CreateTempPath("mp4");
    const result = await recordingStore().ExportClip(clipID, path, {}, false);
    if (result !== EXPORT_SUCCESS) {
      throw new Error(`Steam couldn't export the clip (error ${result}).`);
    }
    return path;
  };
  const next = exportQueue.then(run, run);
  exportQueue = next.catch(() => undefined);
  return next;
}

/** Turns the clip share sheet's request into a clip Steam can export, runs `use` on it, then cleans up. */
export async function withRequestedClip<T>(
  request: ClipCreationRequest,
  use: (summary: ClipSummary) => Promise<T>,
): Promise<T> {
  const created = await request.create(true);
  if (created.result !== RESULT_OK || !created.clipSummary) {
    throw new Error(`Steam couldn't prepare the clip (error ${created.result}).`);
  }
  try {
    return await use(created.clipSummary);
  } finally {
    request.cleanup();
  }
}

/** Calls `onClip` for every clip the user saves. Temporary clips made for sharing are skipped. */
export function onClipSaved(onClip: (summary: ClipSummary) => void): () => void {
  const registration = recordingService()?.RegisterForNotifyClipCreated((message) => {
    try {
      const summary: ClipSummary = message.Body().summary().toObject();
      if (!summary.temporary) {
        onClip(summary);
      }
    } catch (err) {
      console.error("[immichuploader] could not read created clip", err);
    }
    return RESULT_OK;
  });

  if (!registration) {
    console.error("[immichuploader] Steam's game recording service wasn't found; videos won't upload automatically");
  }
  return () => registration?.unregister();
}

export function gameName(gameID: string): string {
  const appStore = (window as any).appStore;
  return appStore?.GetAppOverviewByGameID?.(gameID)?.display_name ?? "";
}
