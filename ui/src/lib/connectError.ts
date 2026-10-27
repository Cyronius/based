// Traces: BASED-CONN-ERROR-TEXT
// Turns raw driver connect errors into one plain sentence. The raw text stays available as detail;
// an unknown message passes through unchanged.

export interface ConnectErrorText {
  summary: string;
  detail: string | null;
}

const RULES: Array<[RegExp, (m: RegExpMatchArray) => string]> = [
  [/Folder not found: "([^"]*)"/, (m) => `Folder not found: ${m[1]}`],
  [/Failed to connect to (\S+?)(?: - |\s|$)/i, (m) => `Server not reachable at ${m[1]}`],
  [/getaddrinfo ENOTFOUND (\S+)/i, (m) => `Server name not found: ${m[1]}`],
  [/ECONNREFUSED|Could not connect/i, () => "Server not reachable"],
  [/Login failed for user '([^']*)'/i, (m) => `Login failed for ${m[1] || "this user"}`],
  [/Incorrect username or password/i, () => "Incorrect username or password"],
  [/Role '?([^' ]+)'? (?:specified in the connect string )?does not exist or not authorized/i, (m) => `Role ${m[1]} does not exist or is not granted to this user`],
  [/(?:account|Account) .*(?:not found|does not exist)|Incorrect account|Could not find account/i, () => "Snowflake account identifier not recognized"],
  [/az login|AzureCliCredential|Azure CLI could not be found/i, () => "Azure CLI sign-in needed — run az login"],
  [/ETIMEDOUT|timed? ?out/i, () => "Connection timed out"],
];

export function describeConnectError(message: string): ConnectErrorText {
  const raw = message.trim();
  for (const [re, toText] of RULES) {
    const m = raw.match(re);
    if (m) {
      const summary = toText(m);
      return { summary, detail: summary === raw ? null : raw };
    }
  }
  return { summary: raw, detail: null };
}
