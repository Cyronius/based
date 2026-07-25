# based — project instructions

## UI style rules

- Never use uppercase text for labels (`text-transform: uppercase` or manual `.toUpperCase()`). It reads as dated. For label emphasis, use a heavier font weight instead (e.g. `font-weight: 700–800`), optionally with modest letter-spacing.

- Any icon/emoji-only control (close ✕, gear, edit ✎, chevrons, etc.) must be a proper **icon button** — a square, centered, adequately-sized clickable box (≥ ~28px), so the whole button is the hit target, not just the glyph. Use the shared [`IconButton`](ui/src/components/IconButton.tsx) component; pass color/hover-color utilities via `className`. Never wrap a bare glyph in a `<button>` with only text color and no padding — that leaves a tiny, hard-to-hit target. Buttons with a visible text label are regular `<button>`s and don't use this.

- Very common operations use a generally-understood icon, not a text label: add → `+`, edit → `✎`, close → `✕`, duplicate/copy → `CopyIcon`, delete → `TrashIcon` (SVGs in [`icons.tsx`](ui/src/components/icons.tsx) — unicode candidates render inconsistently on Windows). Render them with `IconButton` and always pass both `title` and `aria-label` carrying the operation name, since there's no visible text. Exceptions that keep text labels: dropdown/menu rows (e.g. "+ New connection") and dialog-footer actions (Save / Cancel / Test connection / confirm-Delete).
