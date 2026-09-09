# Capi avatar: better art, bigger motion, reactive moods

**Spec impact:** new requirements `BASED-CAPI-MOOD` (unit) and `BASED-CAPI-AVATAR` (manual); `BASED-CHAT-UI` step 5 updated to point at them.

## Why it looks bad today

[CapiAvatar.tsx](../../../ui/src/components/CapiAvatar.tsx) is the demo HTML pasted into JSX:

- Flat fills, one outline color, no shading. Head and body are stacked ellipses with no depth cue.
- Eyes are 13px black dots with one white pixel. At the chat-row size (`h-24`, 96px tall for a 400x520 viewBox) the whole face is ~35px, so the expressions are literally invisible.
- Only motion is `scaleY(1.012)` breathing — a 1% stretch at 96px is under one pixel.
- Expression crossfades take 700ms, so even a real change reads as nothing happening.
- Expressions are picked at random every 30–90s (`pickNextPreset`), with a comment saying "wire this to real state later". That's the reactivity gap.

## Design

### 1. Art (SVG only, no raster)

Keep the 400x520 coordinate space and the layered approach; redraw inside it.

- **Chibi proportions.** Head takes ~55% of the height, body is a rounded loaf below. Bigger head = readable face at 96px.
- **Shading.** `radialGradient` fur (lighter crown/cheeks `#E7B06C` → base `#DDA05F` → underside `#B97F45`), lighter muzzle patch, belly patch, a soft ground shadow ellipse under the body. Outline drops to 3px, color `#3B2A1E` at 0.9 opacity so it stops looking like a coloring book.
- **Eyes.** Radius 13 → 20. Layers: dark iris ring `#4A3323`, pupil `#1C1410`, two highlights (large upper-left, small lower-right). Pupil + highlights live in their own `<g>` so gaze can translate them. Fur-colored **eyelid** shapes over each eye, `scaleY` from the top edge, so blinks and half-lids are transforms, not new poses.
- **Nose/muzzle.** Rounded-square muzzle with a glossy highlight; nostrils as small commas; three whisker dots per cheek.
- **Ears.** Inner ear with a lighter rim, each ear its own `<g>` with `transform-origin` at its base so it can rotate.
- **Fur tufts.** Three short strokes at the crown, two on each cheek. Cheap, reads as "drawn" rather than "assembled".
- **Optional:** a small orange on the head (the capybara meme). Off by default; one boolean if Josh wants it. Decide at review.

Two framings via a `variant` prop:
- `"bust"` (chat row): `viewBox="50 0 300 300"` — head and shoulders. This is the single biggest legibility win.
- `"full"` (disconnected rail): whole body.

### 2. Motion model

Every moving part is a `<g>` with `transform-box: fill-box` and an explicit `transform-origin`, animated by CSS classes. Amplitudes are sized to read at 96px:

| Part | Idle | Notes |
|---|---|---|
| Body | breathe `scaleY 1 → 1.03`, 3.6s | was 1.012 |
| Head | bob `translateY 0 → -4px`, `rotate -2° → 2°`, 3.6s, offset phase | new |
| Eyelids | blink 130ms every 2.5–6s, 20% double-blink | JS timer toggles class |
| Ears | twitch `rotate ±10°` 350ms every 5–12s, one ear at a time | JS timer |
| Pupils | gaze `translate` up to ±5px | driven by mood, else cursor-tracking |

Pose crossfades drop from 700ms to 220ms. Mood-entry one-shots (hop, shake) are keyframes on the root `<g>`.

`@media (prefers-reduced-motion: reduce)`: no breathe/bob/hop/shake/talk-flap; expressions and blinks stay.

### 3. Moods (the reactive part)

`Mood` is a closed union. Random selection is deleted; the only randomness left is idle micro-behaviour (blink, ear twitch, glance).

| Mood | Trigger | Face | Body |
|---|---|---|---|
| `idle` | nothing happening | neutral brows, neutral mouth, gaze follows cursor inside the rail | breathe + bob |
| `sleepy` | `idle` for > 3 min with no input focus | lids at 60%, gaze down, mouth neutral | slower breathe, head drooped 6° |
| `listening` | textarea focused **and** non-empty | brows raised, ears perked (rotate outward 8°), gaze toward input (right) | head tilts 4° toward the textarea |
| `thinking` | `isStreaming`, last activity step is `thinking`, no `currentMessage` | one brow raised (asymmetric), gaze up-left, small "o" mouth, three pulsing thought dots above the head | slow sway |
| `working` | `isStreaming`, last step is a `tool` (not `run_mutation`) | lids at 25% (focused squint), gaze down | quick nod loop 0.6s |
| `waiting` | `isStreaming`, last step is `run_mutation` (approval card is up) | brows raised, wide eyes, gaze straight at user | lean forward 3px |
| `talking` | `currentMessage` length is growing | neutral/happy eyes, mouth flaps open/closed at ~140ms while deltas keep arriving (250ms silence stops it) | small bob |
| `happy` | turn settled with a final assistant text | happy eyes (arched), big smile, ear wiggle | one hop (`translateY -8px` bounce) then decays to `idle` over 4s |
| `concerned` | new `error_` message, stall prompt shown, or continue prompt shown (`producedNothing` / `endedOnToolCalls`) | concerned brows, frown, ears drooped 12° | one head shake (`rotate ±3°` ×3, 600ms), stays until next send |

Mood derivation is a pure function so it's unit-testable and so CapiChat doesn't grow another 60 lines of conditionals:

```ts
// ui/src/agent/capiMood.ts
export type Mood = "idle" | "sleepy" | "listening" | "thinking" | "working" | "waiting" | "talking" | "happy" | "concerned";
export interface MoodSignals {
  isStreaming: boolean;
  streamingText: boolean;      // currentMessage non-empty
  lastStepKind: "thinking" | "tool" | null;
  lastStepTool: string | null;
  hasError: boolean;           // last non-tool message id starts with "error_"
  stalled: boolean;
  needsContinue: boolean;      // showContinue
  justAnswered: boolean;       // lastTurnMs set within the last 4s and no error
  inputFocused: boolean;
  inputText: string;
  idleMs: number;              // since last signal change / pointer activity
}
export function deriveMood(s: MoodSignals): Mood
```

Precedence (first match wins): concerned → waiting → working → talking → thinking → happy → listening → sleepy → idle.

`talking` needs a growth detector, not just "text present": `useSpeaking(currentMessage)` hook sets `speaking=true` on each length change and clears it after 250ms of no change. That's the one piece of state that lives in the component rather than the pure function.

### 4. Wiring

- **CapiChat.tsx** — build `MoodSignals` from existing state (`isStreaming`, `currentMessage`, `useActivity` steps, `stalled`, `showContinue`, `lastTurnMs`, input value, a new `inputFocused` state from textarea focus/blur, and an `idleMs` ticker). Pass `mood`, `speaking`, `variant="bust"`. `justAnswered` is a 4s window opened when `setLastTurnMs` fires.
- **RightRail.tsx** — disconnected state passes `variant="full" mood="idle"`; it will drift to `sleepy` on its own.
- **CapiAvatar.tsx** — props become `{ mood, speaking?, variant?, className? }`. Internals: blink/ear-twitch timers, cursor gaze listener (only when `mood === "idle"`, `pointermove` on the closest `aside`, rAF-throttled), mood-entry one-shot classes (hop/shake) keyed on mood transitions.
- **index.css** — replace `capy-breathe`/`capy-slot-pose` with the keyframe set above plus the reduced-motion block.
- **assets/capi/capy-demo.html** — replace with a mood gallery (one avatar per mood, plus a "speaking" toggle) so the art can be iterated in a plain browser. Not shipped; dev reference only.

### 5. Spec + tests

- `BASED-CAPI-MOOD` (unit): `deriveMood` precedence and thresholds. Test at `specs/based/tests/unit.capiMood.test.ts`, imports `../../../ui/src/agent/capiMood` like the other unit tests. Written red first.
  - streaming + tool step `run_mutation` → `waiting`
  - streaming + tool step other → `working`
  - streaming + thinking step + no text → `thinking`
  - streaming + text growing → `talking` (over `thinking`)
  - hasError → `concerned` even when streaming
  - needsContinue / stalled → `concerned`
  - justAnswered, not streaming → `happy`
  - input focused + non-empty → `listening`; focused + empty → `idle`
  - idleMs ≥ 180 000 and nothing else → `sleepy`; input focused blocks `sleepy`
- `BASED-CAPI-AVATAR` (manual): procedure in `manual.ui.test.ts` — connect, focus and type (listening: head tilt, ears up), send (thinking dots, then working squint on a tool call, then mouth flap while text streams, then hop + smile on settle), point a profile at a bad URL and send (concerned shake, frown), leave the rail alone 3 min (sleepy), enable OS reduced-motion (no bob/hop, expressions still change), disconnected rail shows full-body variant.
- `BASED-CHAT-UI` step 5 rewritten to reference `BASED-CAPI-AVATAR`.

## Files

| File | Change |
|---|---|
| `ui/src/components/CapiAvatar.tsx` | rewrite art, animation groups, props |
| `ui/src/agent/capiMood.ts` | new — `Mood`, `MoodSignals`, `deriveMood` |
| `ui/src/components/CapiChat.tsx` | signals → mood, `useSpeaking`, focus state, idle ticker |
| `ui/src/components/RightRail.tsx` | `variant="full"` |
| `ui/src/index.css` | keyframes, reduced-motion |
| `assets/capi/capy-demo.html` | mood gallery |
| `specs/based/spec.md` | two new requirements, `BASED-CHAT-UI` step 5 |
| `specs/based/tests/unit.capiMood.test.ts` | new |
| `specs/based/tests/manual.ui.test.ts` | `BASED-CAPI-AVATAR` block |

## Risks / calls to make at review

- **Art quality is subjective and I can't preview it in this session.** Plan is to iterate in the demo HTML gallery first, screenshot via the Playwright dev session, and adjust before touching the app.
- **Cursor-tracking gaze** is charming but can look twitchy at 96px. Ship it behind idle-only and a 5px clamp; easy to remove.
- **`talking` flap on very fast local models** could strobe. 140ms flap with a 250ms silence cutoff is the guess; tune in the manual pass.
- **`sleepy` in the chat row** — 3 min is a guess. Could be annoying if it triggers while the user is reading a long answer. Pointer activity inside the rail resets `idleMs`, which should cover reading.
- **Orange on head:** yes/no?
