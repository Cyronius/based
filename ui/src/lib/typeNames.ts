// Traces: BASED-TYPE-NAMES — plain words beside raw engine type names (Arrow's Utf8 means little to most readers).
const PLAIN: Array<[RegExp, string]> = [
  [/^(large)?utf8$|^largestring$/i, "text"],
  [/^u?int(8|16|32|64)$/i, "integer"],
  [/^float(16|32|64)$|^halffloat$/i, "number"],
  [/^bool(ean)?$/i, "true/false"],
  [/^date(32|64)?$/i, "date"],
  [/^timestamp(\(.*\))?$/i, "date and time"],
  [/^(large)?binary$/i, "bytes"],
];

/** The plain name for an Arrow-style type, or null when there is none or the raw name already reads plainly. */
export function plainTypeName(raw: string): string | null {
  const t = raw.trim();
  for (const [re, plain] of PLAIN) if (re.test(t)) return plain.toLowerCase() === t.toLowerCase() ? null : plain;
  return null;
}

/** Index kinds as people say them. */
export function plainIndexType(raw: string): string {
  const t = raw.trim().toLowerCase();
  if (t === "fts" || t === "inverted") return "full-text";
  if (t === "btree") return "sorted (btree)";
  if (t === "bitmap") return "bitmap";
  if (t.startsWith("ivf")) return `vector (${raw.trim()})`;
  return raw;
}
