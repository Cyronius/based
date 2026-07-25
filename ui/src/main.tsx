import React from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import "@glideapps/glide-data-grid/dist/index.css";
import monaco from "./monacoSetup";
import { applyTheme, themeHint, applyFontScale, fontScaleHint, syncMonacoTheme } from "./theme";
import { initLsp } from "./lsp/manager";
import { registerLspProviders } from "./lsp/providers";
import { App } from "./App";

// Paint the hinted theme onto <html> before React mounts (avoids a flash); the server value
// reconciles it once App boots. Monaco's "based" theme is defined from the resulting variables.
applyTheme(themeHint());
applyFontScale(fontScaleHint());
syncMonacoTheme(monaco);
// Language intelligence (BASED-LSP-UI): providers registered once; the manager opens/closes the
// per-session LSP socket as the store's connection + capabilities change.
initLsp();
registerLspProviders();

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
