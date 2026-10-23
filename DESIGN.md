---
name: Based — Mint Tabscape
description: A mint and forest workspace world with layered engine tabs and screenshot-sourced Capi.
colors:
  mint: "#daf7e7"
  mint-deep: "#c6e8d9"
  forest: "#153f32"
  ink: "#071612"
  muted: "#3d685f"
  paper: "#f5f9f8"
  line: "#dce9e5"
  yellow: "#fbf7aa"
  active: "#f7f5c2"
  white: "#fff"
  action: "#0a3327"
  action-hover: "#174d39"
  focus: "#2a7556"
  tab-mint: "#c7ead9"
  fold: "#245741"
  landscape: "#81b59f"
  sql-keyword: "#1655f3"
  sql-string: "#a4431e"
  sql-function: "#ab6400"
  sql-comment: "#58786d"
typography:
  display:
    fontFamily: "Inter, sans-serif"
    fontSize: "74px"
    fontWeight: 900
    lineHeight: 1
    letterSpacing: "-0.04em"
  headline:
    fontFamily: "Inter, sans-serif"
    fontSize: "39px"
    fontWeight: 900
    lineHeight: 1.18
    letterSpacing: "-0.04em"
  body:
    fontFamily: "Inter, sans-serif"
    fontSize: "20px"
    fontWeight: 400
    lineHeight: "26px"
    letterSpacing: "normal"
  navigation:
    fontFamily: "Inter, sans-serif"
    fontSize: "14px"
    fontWeight: 550
    lineHeight: "normal"
    letterSpacing: "normal"
  button:
    fontFamily: "Inter, sans-serif"
    fontSize: "13px"
    fontWeight: 600
    lineHeight: "normal"
    letterSpacing: "normal"
  ui:
    fontFamily: "Inter, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: "normal"
    letterSpacing: "normal"
  code:
    fontFamily: "Consolas, Liberation Mono, monospace"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: "20px"
    letterSpacing: "normal"
rounded:
  object: "3px"
  editor: "4px"
  control: "5px"
  query: "7px"
  message: "8px"
  action: "10px"
spacing:
  micro: "4px"
  tight: "6px"
  compact: "8px"
  label: "10px"
  control: "12px"
  group: "16px"
  action: "20px"
  section: "24px"
  inset: "32px"
  workbench: "36px"
  page: "48px"
components:
  button-primary:
    backgroundColor: "{colors.action}"
    textColor: "{colors.white}"
    typography: "{typography.button}"
    rounded: "{rounded.action}"
    padding: "0 20px"
    height: "46px"
  button-primary-hover:
    backgroundColor: "{colors.action-hover}"
  button-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.button}"
    rounded: "{rounded.action}"
    padding: "0 20px"
    height: "46px"
  small-button:
    backgroundColor: "#fbfdfc"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "7px 11px"
  engine-tab:
    backgroundColor: "{colors.tab-mint}"
    textColor: "{colors.ink}"
    padding: "0 24px"
    width: "278px"
    height: "52px"
  engine-tab-selected:
    backgroundColor: "{colors.yellow}"
    height: "58px"
  query-tab-selected:
    backgroundColor: "{colors.active}"
    textColor: "#17251a"
    padding: "0 11px"
  agent-query:
    backgroundColor: "#eff7f3"
    textColor: "#243e34"
    rounded: "{rounded.query}"
    padding: "12px"
---

# Design System: Based

## Overview

**Creative North Star: "Mint Tabscape"**

The implemented marketing world combines a spacious mint field, heavy forest and ink typography, pale yellow active tabs, and cool white working surfaces. Oversized engine tabs make the shared database workspace tangible; fine labels, SQL, and real HTML tables retain the density of a desktop database client.

Capi supplies the warm tan illustration within this green world. Preserve the existing lowercase `based` identity and Capi's screenshot-derived character. This record describes the static marketing surface under `site/`; it does not redefine the separate desktop application's theme.

**Key Characteristics:**

- Oversized layered tabs with dark rear folds.
- Heavy Inter headlines beside compact functional UI.
- Mint surroundings, forest structure, yellow selection, cool white content.
- One shared transparent Capi asset in the workbench and proof illustration.
- Local, semantic demonstration controls that expose the workspace mechanism.

The source of truth is `site/styles.css`, `site/index.html`, and `site/app.js`. Direction comes from `.impeccable/surfaces/site-index-html.md` and the selected `.impeccable/mocks/decision/10-mint-tabscape-capi-v2.png`. Review captures are `.impeccable/review/desktop.png`, `tablet.png`, and `mobile.png`. These are implementation evidence, not a claim that automated lifecycle gates passed; the recorded workflow remains at supplemental component-review approval.

## Colors

The palette pairs a cool, light mint environment with nearly black green lettering and a restrained warm yellow selection signal. Frontmatter records the actual CSS values.

### Primary

- **Forest:** structural workbench outline, icon accents, and the dark visual anchors.
- **Ink:** primary copy and the headline.
- **Action / Action Hover:** download button fill and its hover state.
- **Mint / Mint Deep:** page field and supporting green family.
- **Tab Mint / Fold / Landscape:** inactive engine surfaces, dark rear folds, and the clipped backdrop.

### Secondary

- **Yellow:** selected engine tab, proof tab, and text selection.
- **Active:** quieter selected query tab inside the native workbench.

### Neutral

- **Paper:** the overall workbench surface.
- **White:** editor, message bubbles, and bright working content.
- **Line:** thin divisions between panes and controls.
- **Muted:** explanatory prose.
- **Focus:** the visible keyboard outline.

SQL has its own functional syntax colors: blue keywords, rust strings, ochre functions, and muted green comments. These colors belong to code content, rather than marketing accents.

**The Selection Rule.** Use yellow to identify the active tab; keep the surrounding workspace cool and quiet.

## Typography

**Display and Body Font:** Inter, with a sans-serif fallback. The variable TrueType file is self-hosted at `site/assets/fonts/inter-variable.ttf`, preloaded by the page, and declared for normal weights (100–900) with `font-display: swap`. Font synthesis is disabled.

**Code Font:** Consolas, Liberation Mono, monospace. No separate display face or icon font is used.

### Hierarchy

- **Display:** the wide-screen hero uses the frontmatter display style. At successive viewport thresholds it becomes (70px), (60px), (53px), (52px), and (43px). Weight stays (900); mobile tracking becomes (-0.035em).
- **Headline:** the wide-screen proof heading uses the headline style. Responsive variants range from (30px) to (35px); the smallest layout uses (31px / 1.12).
- **Wordmark:** heavy lowercase Inter (43px / 1), weight (900), tracking (-0.04em); smaller layouts use (36px) and (33px). The embedded app wordmark is (25px), then (21px) on phones.
- **Body:** centered introductory prose uses the body style with a maximum width of (1050px). It reduces to (18px / 25px), (16px / 24–25px), and (14px / 22px). Proof prose ranges from (18px / 27px) to (14px / 23px).
- **Navigation and actions:** midweight navigation and semibold download labels stay compact. The responsive action style is (11px).
- **Workbench UI:** labels generally use (11–12px). Query labels are (12px) on desktop and (11px) on phones. Wide-screen tables use (12px), then (11px), then (10px) on phones. Table numbers use tabular figures and numeric values align right.
- **SQL:** wide-screen code uses the code style, standard desktop uses (13px / 20px), and compact layouts use (11px / 20px), then (11px / 18px).

**The Scale Rule.** Keep expressive headlines and dense functional labels distinct; preserve readable code and horizontal scrolling instead of shrinking whole workbench artwork.

## Layout

The main header, workbench wrapper, and proof section share a maximum width of (1536px). The header has (48px) wide-screen side insets; the workbench wrapper uses (36px). The introductory text is centered; the native workbench fills almost the entire available width.

Spacing is a set of observed practical increments, listed in frontmatter, rather than a claimed mathematical scale. Small internal gaps use (4–12px), grouped controls use (16–24px), and page insets use (32–48px). The desktop workbench is (510px) tall, growing to (550px) at the largest breakpoint. Its top toolbar is (49px); the body uses three columns: explorer (275px), flexible query area, and agent (347px). At (1400px) and below the side panes become (225px) and (300px).

Responsive reflow follows the implemented media queries:

| Viewport condition | Behavior |
| --- | --- |
| At least 1600px | Taller workbench and editor; more introductory space. |
| At most 1400px | Smaller headline, narrower insets and side panes. |
| At most 1120px | Explorer hides; query area and a (290px) agent pane remain. Engine tabs narrow. |
| At most 820px | Header wraps, with downloads retained in a centered second row. Engine tabs flex to fit; decorative close marks and engine-plus link hide. Breadcrumbs hide. Query and (245px) agent panes remain side by side. Proof illustration and copy stack. |
| At most 600px | Workbench body becomes one column: query/results first, then the agent. Query area is (355px) tall. Agent response, checklist, action, and approval note follow vertically. Header and workbench use narrow insets; download links remain visible. |

The body supports a minimum width of (320px). Query tabs, the SQL editor, and results each contain their own overflow. Tables preserve a minimum width of (600px), or (530px) on phones, so full columns remain available by scrolling. The footer wraps on narrow layouts.

## Elevation & Depth

Depth comes primarily from outlined and overlapping tab silhouettes. The engine strip sits above a dark continuous base; each engine tab has a skewed front extension and a darker rear fold. A heavy forest frame anchors the cool white workbench. A clipped green landscape and a mint SVG wave connect it to the proof scene. The wave is decorative and does not receive pointer events.

### Shadow Vocabulary

- **Workbench ambient:** `0 12px 32px #133f3214`.
- **Primary action:** `0 4px 10px #113b3212`.
- **Proof speech bubble:** `0 5px 12px #173d3112`.
- **Rear proof tab:** `0 8px 15px #113b3010`.
- **Tab structure:** inset dark strokes define inactive tabs and the selected tab; these are structural edges.

**The Layer Rule.** Establish the silhouette and dark outline first; use shadows as a subtle supporting cue.

## Shapes

Actions are softly rounded; compact workbench controls use smaller corners. The frontmatter lists the recurring control radii. The workbench has compound corners (20px top, 12px bottom) with a (6px) forest border and (10px) top edge. Phones use (13px top, 9px bottom), a (4px) border, and a (7px) top edge.

Engine tabs have rounded upper corners (18px / 20px), a skewed extension (20deg), and a dark rear fold (23deg). Mobile upper corners tighten to (12px). At (820px) and below, tab gutters are (10px), the face extension reduces to (12px) wide with a (12deg) skew, and the rear fold reduces to (17px) wide with a (15deg) skew. Preserve the distinction between the selectable tab face and its rear fold; folds must leave adjacent engine labels visible.

Interior separators are generally (1px). Proof tabs use (1.5px) outlines; the raised rear proof tab uses (2px). Query tabs round only their upper selected corners. No generic pill or floating card grid replaces these workspace forms.

## Components

### Download actions and navigation

The primary download link is a dark filled action; the macOS preview is a transparent outlined action. Desktop actions have a minimum height of (46px), reducing to (42px) in the wrapped header. Primary hover deepens the green; secondary hover adds mint. Both move upward (1px) over (180ms ease-out). The current navigation link has a narrow yellow underline.

Navigation uses actual links. Buttons perform local actions. Keep the platform labels and destinations meaningful; the release page provides the fallback while the public release API can resolve a platform asset.

### Engine and query tabs

Engine controls are native buttons with tab semantics. The selected engine exposes yellow, a taller front face, and the highest layer. Selecting an engine updates its connection context, objects, example SQL, and rows.

Query tabs use a quieter active yellow. They retain numeric labels, horizontal overflow, an add control, and a visible close mark. Arrow keys, Home, and End navigate both tab sets through a roving tab stop. Delete closes a query tab, while preserving at least one tab. Selected tabs are linked to their panels with ARIA state and IDs.

### Native workbench

The workbench is live HTML, including toolbar buttons, object search, table-object buttons, syntax-highlighted preformatted SQL, a sortable results table, and CSV export. Search is a compact transparent field with a search icon; an empty-state message appears when no table matches. Small action buttons use thin borders and a pale surface; icon buttons are quiet until hover.

Rows and headers stay in a real table. Column headers contain sorting buttons, with `aria-sort` on the selected header. Results overflow is keyboard-focusable and labeled. All illustrative interactions operate on browser-local sample data; the page does not connect a database or invoke a remote model.

### Capi response and proof

The agent response places Capi beside a bordered white message, followed by a green-check checklist, a pale query action, and an approval note. At phone widths these form a single column. The proof scene reuses Capi next to a white speech action and an angled strip of illustrative query tabs; its tab artwork is hidden from assistive technology.

Capi's identity source is the tan capybara in `docs/screenshots/hero.png`, cropped at `96x112+2185+1295`. The production image was cleaned and upscaled using the prompt in `.impeccable/capi-asset-prompt.txt`; its provenance is `site/assets/capi.webp.json`. This is a screenshot-referenced generated cleanup, not an unmodified screenshot crop. The two specification plates (`assets/plates/capi-agent.png` and `capi-proof.png`) share the same image. Both shipping placements load `site/assets/capi.webp`, a lossless WebP conversion resized to a maximum of (320×480) while preserving alpha, as recorded in `.impeccable/review/asset-mapping.json`.

Keep Capi tan with its flat illustration, dark outline, round ears, broad muzzle, small eyes, seated body, and gentle expression. Its on-page dimensions vary by context; maintain containment and aspect ratio. The in-workbench image has descriptive alt text, while the repeated proof image is decorative.

### Focus, feedback, and motion

Interactive controls use a (3px) green `:focus-visible` outline with a (4px) offset. A skip link appears on focus. Landmark labels, native links and buttons, tab relationships, and a polite live status message make interaction state available beyond color and motion. Inline SVG symbols supply icons.

A newly opened query arrives over (500ms) with `cubic-bezier(.16,1,.3,1)`; Capi nods over (600ms ease-out); the rear proof tab lifts over (450ms) with the same arrival easing. Asking Capi briefly disables its action and announces the local result. With reduced motion, CSS disables all animations and transitions, smooth scrolling is removed, and the simulated Capi wait becomes zero. Retain these state and accessibility conventions when extending components.

## Do's and Don'ts

### Do:

- **Do** preserve the mint field, forest structure, yellow selected tabs, and cool white working surfaces.
- **Do** use self-hosted Inter with heavy headlines and compact functional labels.
- **Do** preserve native semantic controls, visible focus, local feedback, and reduced-motion behavior.
- **Do** reflow the agent below the query area on phones and contain code, tabs, and result overflow.
- **Do** reuse the shared transparent Capi asset and retain its provenance.

### Don't:

- **Don't** replace Capi with a robot, recolor it mint, or add new character props.
- **Don't** flatten the engine tabs into generic pills or let rear folds obscure their labels.
- **Don't** substitute a screenshot for the functional workbench demonstration.
- **Don't** present browser-local sample interactions as a live database or remote AI connection.
