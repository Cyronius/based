// Manual/e2e verification procedures — the spec's acceptance criteria are the artifact.
// Full step-by-step procedures live in specs/based/spec.md under each requirement.
import { describe, it } from "bun:test";

// Traces: BASED-UI-LAYOUT (canonical spec: specs/based/spec.md)
// Verification: manual — launch app; left rail + center render; right-rail placeholder toggles.
describe.skip("BASED-UI-LAYOUT: manual verification", () => {
  it.todo("see spec.md procedure");
});

// Traces: BASED-UI-CONNECTIONS (canonical spec: specs/based/spec.md)
// Verification: manual — create/test/save/edit/delete connection; database + schema selectors.
describe.skip("BASED-UI-CONNECTIONS: manual verification", () => {
  it.todo("see spec.md procedure");
});

// Traces: BASED-UI-EXPLORER (canonical spec: specs/based/spec.md)
// Verification: manual — accordion groups with counts; double-click table → details tab.
describe.skip("BASED-UI-EXPLORER: manual verification", () => {
  it.todo("see spec.md procedure");
});

// Traces: BASED-UI-TABS (canonical spec: specs/based/spec.md)
// Verification: manual — tab persistence across restart, Ctrl+S save, F5 run, cancel, resizable panes.
describe.skip("BASED-UI-TABS: manual verification", () => {
  it.todo("see spec.md procedure");
});

// Traces: BASED-UI-RESULTS (canonical spec: specs/based/spec.md)
// Verification: manual — result-set sub-tabs, grid/text toggle, copy, CSV/XLSX export, Open in Excel, row-cap notice.
describe.skip("BASED-UI-RESULTS: manual verification", () => {
  it.todo("see spec.md procedure");
});

// Traces: BASED-UI-OUTPUT (canonical spec: specs/based/spec.md)
// Verification: manual — readable error text in Output; visible reconnecting state after token expiry.
describe.skip("BASED-UI-OUTPUT: manual verification", () => {
  it.todo("see spec.md procedure");
});

// Traces: BASED-AUTH-INTERACTIVE (canonical spec: specs/based/spec.md)
// Verification: manual — Test Connection with "Entra ID (interactive)" opens browser, sign-in succeeds.
describe.skip("BASED-AUTH-INTERACTIVE: manual verification", () => {
  it.todo("see spec.md procedure");
});

// Traces: BASED-AUTH-SQLLOGIN (canonical spec: specs/based/spec.md)
// Verification: manual — SQL auth connection succeeds; wrong password fails readably.
describe.skip("BASED-AUTH-SQLLOGIN: manual verification", () => {
  it.todo("see spec.md procedure");
});

// Traces: BASED-AUTH-SP (canonical spec: specs/based/spec.md)
// Verification: manual — service principal connection succeeds.
describe.skip("BASED-AUTH-SP: manual verification", () => {
  it.todo("see spec.md procedure");
});

// Traces: BASED-AGENT-INSTRUCTIONS-UI (canonical spec: specs/based/spec.md)
// Verification: manual — gear panel next to Ask Capy exposes the instruction-set picker + three
// collapsible boxes; Default is read-only; duplicate/edit/save/delete/switch all persist.
describe.skip("BASED-AGENT-INSTRUCTIONS-UI: manual verification", () => {
  it.todo("see spec.md procedure");
});

// Traces: BASED-WINDOW-RESTORE (canonical spec: specs/based/spec.md)
// Verification: manual — open 2 windows (Ctrl+N) on different connections with tabs open, quit
// (both cleanly and via kill) and relaunch → both windows reopen with connection/tabs/active
// tab/schema filter intact; a cleanly-closed window does not come back.
describe.skip("BASED-WINDOW-RESTORE: manual verification", () => {
  it.todo("see spec.md procedure");
});

// Traces: BASED-CONN-SWITCH-CACHE (canonical spec: specs/based/spec.md)
// Verification: manual — switching between connections already visited this session is instant
// and lossless (tabs/active tab/schema filter restored, no refetch); an edit typed within 700ms of
// switching is not dropped.
describe.skip("BASED-CONN-SWITCH-CACHE: manual verification", () => {
  it.todo("see spec.md procedure");
});

// Traces: BASED-LANCE-FOLDER-BROWSE (canonical spec: specs/based/spec.md)
// Verification: manual — Browse button next to the LanceDB Local directory-path field opens a native
// folder picker and fills the field; the button is absent in Cloud mode.
describe.skip("BASED-LANCE-FOLDER-BROWSE: manual verification", () => {
  it.todo("see spec.md procedure");
});
