// Traces: BASED-ERROR-HEADLINE
// Driver errors (LanceDB's Rust chain especially) bury the cause under "Caused by:" frames and
// source locations; the headline is the first sentence a person can act on.

const SOURCE_LOCATION = /,?\s*(?:[A-Za-z]:)?[\\/][^\s,]*\.rs:\d+(?::\d+)?\s*$/;

export function errorHeadline(full: string): string {
  const first = full.split(/\r?\n|\bCaused by:/)[0]!.replace(SOURCE_LOCATION, "").trim();
  return first || full.trim();
}
