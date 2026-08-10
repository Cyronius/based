# Screenshots

The README references these by exact filename. Drop them in here and it completes itself — no
markdown edits needed.

## Capture settings

- **2560x1440 at 100% display scaling.** This was originally forced by the Electrobun shell, whose
  WebView2 rendered at 96dpi with no per-monitor DPI awareness, so anything above 100% looked soft.
  Tauri may well handle scaling better — that has not been re-verified — but keep capturing at 100%
  so new screenshots match the existing set.
- Downscale to **1600px wide** for the repo. The README requests them at `width="800"` (900 for the
  hero), so 1600 gives a crisp 2x.
- **Use a demo database with non-sensitive data.** Schema names, table names, and rows are legible
  in every one of these.
- **Pick one theme and stay in it** for all shots except `themes.png`, so the page reads as one
  product. `ledger` or `blueprint` both photograph well.
- Close anything transient — no half-open menus, no error toasts, no empty grids.

## The list

| File | Shot | Must be visible |
|---|---|---|
| `hero.png` | Full window: query tab, results populated, agent mid-answer in the right rail | All three regions at once; a real result grid; a SQL block in chat showing its Insert/Run buttons |
| `agent-tabs.png` | The agent has just opened a new tab with results | The new tab in the strip **and** its populated grid — this is the "not a chat bubble" proof |
| `agent-approval.png` | A `run_mutation` approval card in the rail | The proposed SQL and the Approve/Reject buttons |
| `agent-activity.png` | The activity feed mid-run | Thinking → tool-name steps, spinner on the current one, and one settled row expanded to show JSON args + result |
| `atlas.gif` | **Animated**, 6–10s, under ~8 MB — UMAP converging | The condensing motion from noise into structure, cluster tints, legend chips. Highest-value asset on the page. |
| `plan.png` | Execution plan operator tree with one node selected | The detail card: estimated vs actual rows, costs |
| `details.png` | Table Details sub-view, scrolled to show breadth | Indexes, Foreign keys, and the DDL block together |
| `lance-search.png` | LanceDB Data tab in Search mode, results returned | `_rerank_score` column and a vector column rendering as `vec[768] [...]` |
| `themes.png` | 3x2 composite of the same view in 6 themes | 2 dark, 2 midtone, 2 light — pick pairs whose **fonts** differ, not just palettes |

## Also worth having (not yet referenced by the README)

| File | Shot |
|---|---|
| `social-preview.png` | 1280x640, hero crop + wordmark. Set it under repo Settings → Social preview; it's what renders when the link is shared anywhere. |
| `atlas-lasso.png` | Lasso selection with the bottom grid panel populated |
| `diagram.png` | ER diagram tab, 6–10 tables, PK/FK glyphs and edges legible |
| `edit-data.png` | Edit Data with dirty-cell tints and the Review SQL peek open |
| `settings-agent.png` | Gear → Agent, a profile configured against LM Studio, params JSON visible |
