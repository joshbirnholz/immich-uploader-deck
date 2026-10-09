import { findModule } from "@decky/ui";
import { ReactNode, createContext, useContext } from "react";
import { FaCloudUploadAlt } from "react-icons/fa";

// Steam's screenshot share menu lives in module-private components, and webpack exports
// are non-configurable getters, so there is nothing to patch directly. Instead we wrap
// the JSX runtime Steam renders through:
//   1. the share sheet element (props: screenshot | items, summoningElement, showConfirmation)
//      is wrapped in a context provider carrying the screenshots, and
//   2. its options list (props.options with "clipboard" and "export" entries) is swapped
//      for a component that appends "Upload to Immich" when that context is present.

type LocalScreenshot = {
  type?: string;
  local?: { strGameID: string; hHandle: number };
};

type ShareOption = {
  key: string;
  label: string;
  icon?: ReactNode;
  onSelected?: () => void;
};

type JsxFn = (type: any, props: any, key?: any) => any;

const ScreenshotsContext = createContext<LocalScreenshot[] | null>(null);

function isShareSheetProps(props: any): boolean {
  return (
    props != null &&
    "showConfirmation" in props &&
    "summoningElement" in props &&
    (props.screenshot != null || Array.isArray(props.items))
  );
}

function isShareOptionsProps(props: any): boolean {
  const options = props?.options;
  return (
    Array.isArray(options) &&
    options.some((option: any) => option?.key === "clipboard") &&
    options.some((option: any) => option?.key === "export")
  );
}

function localScreenshots(props: any): LocalScreenshot[] {
  const candidates: LocalScreenshot[] = props.screenshot ? [props.screenshot] : props.items;
  return candidates.filter((item) => item?.local && (item.type === undefined || item.type === "screenshot"));
}

export function patchShareMenu(onUpload: (screenshots: LocalScreenshot[]) => void): () => void {
  const runtime = findModule((m: any) => typeof m?.jsx === "function" && typeof m?.jsxs === "function" && m.Fragment);
  if (!runtime) {
    console.error("[immichuploader] could not find the JSX runtime; share menu not patched");
    return () => {};
  }

  const originalJsx: JsxFn = runtime.jsx;
  const originalJsxs: JsxFn = runtime.jsxs;

  function OptionsWithImmich({ __immichOriginalType: OriginalType, ...props }: any) {
    const screenshots = useContext(ScreenshotsContext);
    const options: ShareOption[] = props.options;
    const withImmich =
      screenshots && screenshots.length > 0
        ? [
            ...options,
            {
              key: "immich",
              label: "Upload to Immich",
              icon: originalJsx(FaCloudUploadAlt, {}),
              onSelected: () => onUpload(screenshots),
            },
          ]
        : options;
    return originalJsx(OriginalType, { ...props, options: withImmich });
  }

  const wrap =
    (original: JsxFn): JsxFn =>
    (type, props, key) => {
      if (typeof type === "function" && type !== OptionsWithImmich) {
        if (isShareSheetProps(props)) {
          return originalJsx(
            ScreenshotsContext.Provider,
            { value: localScreenshots(props), children: original(type, props) },
            key,
          );
        }
        if (isShareOptionsProps(props)) {
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
