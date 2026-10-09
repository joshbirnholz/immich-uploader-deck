import { findModule } from "@decky/ui";
import { ReactNode, createContext, useContext } from "react";
import { ClipCreationRequest, ClipSummary } from "./clips";
import { ImmichIcon } from "./ImmichIcon";

// Steam's share menus live in module-private components, and webpack exports are
// non-configurable getters, so there is nothing to patch directly. Instead we wrap the
// JSX runtime Steam renders through:
//   1. share sheet elements are wrapped in a context provider carrying what's being shared:
//      - a screenshot:         props { screenshot, summoningElement, showConfirmation }
//      - a multi-selection:    props { items, summoningElement, showConfirmation }
//      - a clip:               props { clipCreationRequest, showConfirmation }
//   2. every options list ({key, onSelected} items) is swapped for a component that adds
//      "Upload to Immich" when that context is present.

export type LocalScreenshot = {
  type?: string;
  local?: { strGameID: string; hHandle: number };
};

export type ShareTarget = {
  screenshots: LocalScreenshot[];
  clipRequest?: ClipCreationRequest;
  clips: ClipSummary[];
};

type ShareOption = {
  key: string;
  label: ReactNode;
  icon?: ReactNode;
  onSelected?: () => void;
};

type JsxFn = (type: any, props: any, key?: any) => any;

// Clip share sheets put save actions in their own list; "Upload to Immich" goes in the share list.
const SAVE_OPTION_KEYS = new Set(["save", "saveas", "savetofile", "openfile"]);

const ShareTargetContext = createContext<ShareTarget | null>(null);

function shareTarget(props: any): ShareTarget | null {
  if (props == null || !("showConfirmation" in props)) {
    return null;
  }
  if (props.clipCreationRequest) {
    return { screenshots: [], clipRequest: props.clipCreationRequest, clips: [] };
  }
  if (!("summoningElement" in props)) {
    return null;
  }
  if (props.screenshot) {
    return { screenshots: props.screenshot.local ? [props.screenshot] : [], clips: [] };
  }
  if (Array.isArray(props.items)) {
    return {
      screenshots: props.items.filter((item: any) => item?.type === "screenshot" && item.local),
      clips: props.items.filter((item: any) => item?.type === "clip" && item.summary).map((item: any) => item.summary),
    };
  }
  return null;
}

function isOptionsProps(props: any): boolean {
  const options = props?.options;
  return Array.isArray(options) && options.every((option: any) => option && "key" in option && "onSelected" in option);
}

function isEmpty(target: ShareTarget): boolean {
  return target.screenshots.length === 0 && target.clips.length === 0 && !target.clipRequest;
}

/** Puts Immich directly under "Share on Steam", or first when that option isn't offered. */
function withImmichOption(options: ShareOption[], immich: ShareOption): ShareOption[] {
  const shareOnSteam = options.findIndex((option) => option.key === "upload");
  const index = shareOnSteam + 1;
  return [...options.slice(0, index), immich, ...options.slice(index)];
}

export function patchShareMenu(onUpload: (target: ShareTarget) => void): () => void {
  const runtime = findModule((m: any) => typeof m?.jsx === "function" && typeof m?.jsxs === "function" && m.Fragment);
  if (!runtime) {
    console.error("[immichuploader] could not find the JSX runtime; share menu not patched");
    return () => {};
  }

  const originalJsx: JsxFn = runtime.jsx;
  const originalJsxs: JsxFn = runtime.jsxs;

  function OptionsWithImmich({ __immichOriginalType: OriginalType, ...props }: any) {
    const target = useContext(ShareTargetContext);
    const options: ShareOption[] = props.options;
    // In Big Picture an existing clip's save list is empty, so empty lists count as save lists too.
    const isSaveList = options.every((option) => SAVE_OPTION_KEYS.has(option.key));

    if (!target || isEmpty(target) || isSaveList) {
      return originalJsx(OriginalType, props);
    }

    const immich: ShareOption = {
      key: "immich",
      label: "Upload to Immich",
      icon: originalJsx(ImmichIcon, {}),
      onSelected: () => onUpload(target),
    };
    return originalJsx(OriginalType, { ...props, options: withImmichOption(options, immich) });
  }

  const wrap =
    (original: JsxFn): JsxFn =>
    (type, props, key) => {
      if (typeof type === "function" && type !== OptionsWithImmich) {
        const target = shareTarget(props);
        if (target) {
          return originalJsx(ShareTargetContext.Provider, { value: target, children: original(type, props) }, key);
        }
        if (isOptionsProps(props)) {
          return originalJsx(OptionsWithImmich, { ...props, __immichOriginalType: type }, key);
        }
      }
      return original(type, props, key);
    };

  runtime.jsx = wrap(originalJsx);
  runtime.jsxs = wrap(originalJsxs);

  return () => {
    runtime.jsx = originalJsx;
    runtime.jsxs = originalJsxs;
  };
}

export async function screenshotPath(screenshot: LocalScreenshot): Promise<string> {
  const { strGameID, hHandle } = screenshot.local!;
  // Steam passes the string game ID here (non-Steam game IDs don't fit in a number); Decky's types say number.
  return SteamClient.Screenshots.GetLocalScreenshotPath(strGameID as unknown as number, hHandle);
}
