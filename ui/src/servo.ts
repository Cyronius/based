// Load compatibility shims before evaluating any of the app's dependency modules.
// This entry is selected only by the experimental Servo build modes.
import "abortcontroller-polyfill/dist/polyfill-patch-fetch";
import { ResizeObserver } from "@juggle/resize-observer";

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = ResizeObserver;
}

// Monaco probes this deprecated API at module startup. Servo does not expose it;
// report the capability as unsupported so the editor can use its other paths.
if (typeof document.queryCommandSupported !== "function") {
  document.queryCommandSupported = () => false;
}

void import("./main").catch((error: unknown) => {
  console.error("based could not start in Servo", error);
  const root = document.getElementById("root");
  if (root) {
    root.style.cssText = "padding:32px;font:16px system-ui;color:#f3f4f6;background:#18181b;min-height:100vh;white-space:pre-wrap";
    root.textContent = `based could not start in this Servo engine.\n\n${String(error)}`;
  }
});
