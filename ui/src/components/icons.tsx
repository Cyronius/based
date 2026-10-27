// Shared inline SVG icons for operations that have no reliable unicode glyph (unicode candidates
// like ⧉ / 🗑 render inconsistently or emoji-styled on Windows). Same style as the existing
// hand-rolled icons (GearIcon, NewChatIcon): stroke currentColor, strokeWidth 2, 24×24 viewBox.
// Rendered as the child of an IconButton, which supplies the hit target and hover treatment.

export function CopyIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

// Traces: BASED-CHAT-TRANSCRIPT-UI — arrow into a tray, the conventional "save this to a file".
export function DownloadIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v12" />
      <path d="m7 10 5 5 5-5" />
      <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
    </svg>
  );
}

// Traces: BASED-CHAT-HISTORY-PICKER — a clock, the conventional "history" glyph.
export function HistoryIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

export function ChevronDownIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

export function ChevronUpIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m6 15 6-6 6 6" />
    </svg>
  );
}

/** BASED-AGENT-TAB-MARK: small static capybara head; the animated CapiAvatar is too heavy per tab. */
export function CapiMark({ className }: { className?: string }) {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" className={className} aria-hidden="true">
      <circle cx="5" cy="4" r="1.6" fill="currentColor" />
      <path d="M2.5 7.2C2.5 5.2 4.1 4 6.2 4h4.6c2.6 0 4.2 1.7 4.2 3.8v2c0 1.8-1.3 3.2-3.2 3.2H5.6c-1.8 0-3.1-1.3-3.1-3Z" fill="currentColor" />
      <circle cx="7.2" cy="7" r="0.9" fill="var(--color-ink-950)" />
    </svg>
  );
}

export function TrashIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 6h18" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  );
}
