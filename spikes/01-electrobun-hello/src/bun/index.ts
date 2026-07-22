// Phase 0 spike #1 — Electrobun hello-world on Windows.
// Pattern under test = the real architecture: all UI served from Bun.serve on
// 127.0.0.1:<random port>, webview pointed at it (NOT views:// / NOT Electrobun RPC).
// Checks: window opens, dense text renders SHARP at 1440p/100% scaling
// (electrobun #324 check), devtools open, console logging reaches terminal.

import { BrowserWindow } from "electrobun/bun";

const denseHtml = `<!doctype html>
<html><head><meta charset="utf-8"><title>based spike 1 — DPI / density check</title>
<style>
  body { font-family: "Segoe UI", system-ui, sans-serif; margin: 24px; color: #1a1a1a; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .hint { color: #666; font-size: 12px; margin-bottom: 16px; }
  table { border-collapse: collapse; font-size: 12px; margin-bottom: 16px; }
  td, th { border: 1px solid #ccc; padding: 2px 8px; white-space: nowrap; }
  th { background: #f3f3f3; text-align: left; }
  code, pre { font-family: "Cascadia Mono", Consolas, monospace; }
  pre { font-size: 12px; background: #f7f7f7; border: 1px solid #ddd; padding: 8px; }
  .s10 { font-size: 10px; } .s11 { font-size: 11px; } .s12 { font-size: 12px; } .s14 { font-size: 14px; }
  .px { height: 1px; background: #000; margin: 1px 0; width: 320px; }
</style></head><body>
<h1>based — spike 1: Electrobun on Windows</h1>
<div class="hint">Served from Bun.serve in the Electrobun main process. If this text looks
blurry (not crisp like this terminal/VS Code), the #324 DPI issue is biting — check display scaling.</div>
<div class="s10">10px: The quick brown fox jumps over the lazy dog 0123456789 Iil1| O0o</div>
<div class="s11">11px: The quick brown fox jumps over the lazy dog 0123456789 Iil1| O0o</div>
<div class="s12">12px: The quick brown fox jumps over the lazy dog 0123456789 Iil1| O0o</div>
<div class="s14">14px: The quick brown fox jumps over the lazy dog 0123456789 Iil1| O0o</div>
<p class="hint">1px hairlines (should be distinct lines, not gray mush):</p>
<div class="px"></div><div class="px"></div><div class="px"></div>
<table><tr><th>id</th><th>schema</th><th>table</th><th>rows</th><th>type</th></tr>
${Array.from({ length: 30 }, (_, i) =>
  `<tr><td>${i + 1}</td><td>dbo</td><td>Table_${i + 1}</td><td>${(i * 7919) % 100000}</td><td>BASE TABLE</td></tr>`
).join("")}
</table>
<pre>SELECT TOP 50 c.CustomerID, c.Name, SUM(o.Total) AS Total
FROM dbo.Customers c JOIN sales.Orders o ON o.CustomerID = c.CustomerID
GROUP BY c.CustomerID, c.Name ORDER BY Total DESC; -- monospace sharpness check</pre>
<script>console.log("webview: dense page loaded, devicePixelRatio=" + window.devicePixelRatio);</script>
</body></html>`;

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0, // random port, like the real app
  fetch() {
    return new Response(denseHtml, { headers: { "content-type": "text/html" } });
  },
});
console.log(`[spike1] Bun.serve on http://127.0.0.1:${server.port} (bun ${Bun.version})`);

const win = new BrowserWindow({
  title: "based spike 1 — DPI / density check",
  url: `http://127.0.0.1:${server.port}`,
  frame: { width: 1000, height: 900, x: 200, y: 100 },
});
console.log("[spike1] BrowserWindow created");

// Devtools check: set SPIKE_DEVTOOLS=1 to auto-open the WebView2 devtools.
if (process.env.SPIKE_DEVTOOLS === "1") {
  setTimeout(() => {
    win.webview.openDevTools();
    console.log("[spike1] openDevTools() called");
  }, 1500);
}
