import React from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import "@glideapps/glide-data-grid/dist/index.css";
import "./monacoSetup";
import { App } from "./App";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
