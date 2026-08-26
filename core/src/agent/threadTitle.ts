// Traces: BASED-CHAT-HISTORY-PICKER
// Deterministic chat-title derivation: first words of the conversation's first user message.
// This is deliberately the ONE seam for titling — a tiny CPU-only titling model is planned as a
// future (likely config-optional) replacement, and it must slot in here, at the list route's
// backfill call site, without touching anything else. Keep derivation out of every other layer.

const MAX_WORDS = 6;
const MAX_CHARS = 48;

/** First 6 words of the message, whitespace-collapsed, hard-capped at 48 chars; an ellipsis marks
 *  any dropped tail. Blank input → "Untitled chat". */
export function threadTitle(firstUserText: string): string {
  const words = firstUserText.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "Untitled chat";
  let title = words.slice(0, MAX_WORDS).join(" ");
  let truncated = words.length > MAX_WORDS;
  if (title.length > MAX_CHARS) {
    title = title.slice(0, MAX_CHARS - 1).trimEnd();
    truncated = true;
  }
  return truncated ? `${title}…` : title;
}

/** True when a stored title should be replaced by derivation: unset/blank, or the placeholder
 *  Mastra stamps on auto-created threads (`New Thread <ISO date>`). */
export function isDerivableTitle(title: string | undefined | null): boolean {
  const t = title?.trim();
  return !t || t.startsWith("New Thread");
}
