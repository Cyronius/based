// Traces: BASED-TAB-TITLE-DEDUPE — display-only; stored titles never change (names are sticky).
export function dedupeTitles(tabs: Array<{ id: string; title: string }>): Map<string, string> {
  const seen = new Map<string, number>();
  const out = new Map<string, string>();
  for (const t of tabs) {
    const n = (seen.get(t.title) ?? 0) + 1;
    seen.set(t.title, n);
    out.set(t.id, n === 1 ? t.title : `${t.title} (${n})`);
  }
  return out;
}
