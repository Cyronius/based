// Throwaway reseed using REAL embeddings from the local LM Studio embedder, so vector search
// against this table returns semantically meaningful results (not random-blob nearest-neighbor).
// Same topic/template generator as before; delete when screenshot capture is done.
import * as lancedb from "@lancedb/lancedb";

const outDir = process.argv[2];
if (!outDir) {
  console.error("usage: bun run specs/_reseed-lance-real-embed.ts <outDir>");
  process.exit(1);
}

const TOPICS = [
  {
    category: "Billing",
    templates: [
      "Customer was charged twice for the {plan} plan renewal on {date}.",
      "Invoice #{n} shows an incorrect tax amount for the {plan} subscription.",
      "Requesting a refund for the {plan} plan -- cancelled before the trial ended.",
      "Credit card on file expired; billing retry for {plan} failed on {date}.",
      "Customer asking to switch from monthly to annual {plan} billing.",
      "Proration looks wrong after upgrading mid-cycle from Starter to {plan}.",
      "Purchase order number is missing from the {plan} invoice PDF.",
      "Sales tax is being applied even though the account is tax-exempt.",
      "Asking why the {plan} renewal price is higher than the quote from {date}.",
      "Wants a consolidated invoice across three sub-accounts instead of separate ones.",
      "Payment failed with a generic decline code; card is valid and has funds.",
      "Coupon code for the {plan} plan didn't apply at checkout on {date}.",
      "Billing contact email needs to change from an old {domain} address.",
      "Downgrade from {plan} to Starter didn't stop the higher charge next cycle.",
      "Wants an itemized breakdown of usage-based charges for {date}.",
    ],
  },
  {
    category: "Login / Auth",
    templates: [
      "User locked out after {n} failed login attempts, needs manual unlock.",
      "SSO redirect loops back to the login page without an error message.",
      "Password reset email never arrives for the {domain} domain.",
      "Two-factor code from the authenticator app is rejected every time.",
      "Session expires within a minute of logging in on {browser}.",
      "SAML metadata changed on the {domain} identity provider and login now fails.",
      "New employee at {domain} can't accept the workspace invite link.",
      "Magic-link email lands in spam for every user on the {domain} domain.",
      "Login works on {browser} desktop but not on the mobile app.",
      "Account shows as suspended after a routine password change.",
      "API key generated for {domain} stopped authenticating overnight.",
      "Okta provisioning removed a user's access without an admin action.",
      "Biometric login on the mobile app fails after the phone was restarted.",
      "Shared team login was disabled after the security review on {date}.",
      "Recovery codes for two-factor were never issued at signup.",
    ],
  },
  {
    category: "Performance",
    templates: [
      "Dashboard takes over {n} seconds to load for the {plan} tenant.",
      "Bulk export of {n} rows times out around the 60s mark.",
      "Search results lag noticeably after the last release on {date}.",
      "CPU usage spikes to 100% when switching between large tabs.",
      "Sync between devices is delayed by several minutes intermittently.",
      "Report generation for the {plan} tier hangs at 90% and never completes.",
      "Typing in the editor has a visible lag on {browser} since {date}.",
      "Large attachments cause the whole workspace to slow down for everyone.",
      "API responses that used to take {n}ms now take several seconds.",
      "Autosave stalls on documents with more than {n} embedded images.",
      "Filtering a large table by two columns at once times out.",
      "Cold start after a deploy takes noticeably longer than before {date}.",
      "Memory usage climbs steadily over a long session until the tab crashes.",
      "Websocket reconnects repeatedly under normal office wifi.",
      "Batch jobs queued on {date} are still stuck in 'pending'.",
    ],
  },
  {
    category: "Data Export",
    templates: [
      "CSV export drops the last {n} rows on large tables.",
      "XLSX export corrupts special characters in the {domain} column.",
      "Scheduled export to the {domain} bucket silently stopped on {date}.",
      "Requesting a way to export only rows changed since {date}.",
      "PDF export of the report is missing the summary chart.",
      "Export includes soft-deleted rows that shouldn't be there.",
      "Timezone in exported timestamps doesn't match the account setting.",
      "Wants a JSON export option alongside CSV and XLSX.",
      "Export of {n}+ rows silently truncates without a warning.",
      "Column order in the exported file doesn't match the on-screen view.",
      "Nightly export to {domain} email address stopped after {date}.",
      "Exported numbers are formatted as text and break downstream formulas.",
      "Wants exports to respect the currently active filters, not just sort.",
      "Large export locks the UI instead of running in the background.",
      "Header row is missing from the CSV when exporting via the API.",
    ],
  },
  {
    category: "Mobile App",
    templates: [
      "App crashes on launch on {browser} after the {date} update.",
      "Push notifications stopped arriving for {plan} tier users.",
      "Offline mode doesn't sync changes back once reconnected.",
      "Dark mode toggle has no effect on the settings screen.",
      "Camera permission prompt loops without ever granting access.",
      "App freezes when rotating the phone during a video upload.",
      "Widget on the home screen shows stale data from {date}.",
      "Fingerprint unlock stopped working after the {date} app update.",
      "Deep link from an email opens the app to a blank screen.",
      "Battery drains noticeably faster with the app running in the background.",
      "Tablet layout squeezes everything into the phone's single-column view.",
      "Barcode scanner won't focus on low-end Android devices.",
      "Voice-to-text input in the mobile app produces garbled text.",
      "App Store update on {date} broke saved login sessions.",
      "Notch on newer phones covers the top navigation bar.",
    ],
  },
  {
    category: "Feature Request",
    templates: [
      "Would like bulk-tagging support for the {domain} workspace.",
      "Request: keyboard shortcut for duplicating a row.",
      "Asking for a dark theme option matching the {domain} brand colors.",
      "Feature request: webhook on {plan} plan changes.",
      "Would like an audit log export scoped to a single user.",
      "Requesting a public API rate-limit increase for the {plan} tier.",
      "Wants saved views to be shareable via a link.",
      "Asking for undo history to go back further than the current {n} steps.",
      "Would like SCIM provisioning support for {domain} users.",
      "Requesting a read-only guest role for external reviewers.",
      "Wants scheduled reports emailed weekly instead of manual export.",
      "Asking for a command palette like other tools have.",
      "Would like custom fields to support multi-select, not just single value.",
      "Requesting a sandbox environment separate from the {plan} production account.",
      "Wants keyboard-only navigation through the whole app for accessibility.",
    ],
  },
];

const PLANS = ["Starter", "Team", "Business", "Enterprise"];
const DOMAINS = ["acme.test", "globex.test", "initech.test", "umbrella.test", "wayne.test"];
const BROWSERS = ["Chrome", "Firefox", "Safari", "Edge"];

function fill(template: string, n: number): string {
  return template
    .replace("{n}", String(10 + (n % 90)))
    .replace("{date}", `2026-0${1 + (n % 7)}-${10 + (n % 18)}`)
    .replace("{plan}", PLANS[n % PLANS.length]!)
    .replace("{domain}", DOMAINS[n % DOMAINS.length]!)
    .replace("{browser}", BROWSERS[n % BROWSERS.length]!);
}

const PER_TOPIC = 45;
const items: Array<{ id: number; category: string; text: string; priority: string }> = [];
let id = 0;
for (const topic of TOPICS) {
  for (let i = 0; i < PER_TOPIC; i++) {
    const template = topic.templates[i % topic.templates.length]!;
    items.push({
      id: id++,
      category: topic.category,
      text: fill(template, i),
      priority: i % 9 === 0 ? "high" : i % 3 === 0 ? "medium" : "low",
    });
  }
}

async function embed(text: string): Promise<number[]> {
  const res = await fetch("http://localhost:1234/v1/embeddings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "text-embedding-qwen3-embedding-0.6b", input: text }),
  });
  if (!res.ok) throw new Error(`embed failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { data: Array<{ embedding: number[] }> };
  return body.data[0]!.embedding;
}

// Small concurrency pool -- 270 sequential embed calls would be slow.
async function pool<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!);
    }
  }
  await Promise.all(Array.from({ length: size }, worker));
  return results;
}

console.log(`Embedding ${items.length} texts via LM Studio...`);
const vectors = await pool(items, 8, (it) => embed(it.text));
console.log("Embedding done, writing table...");

const rows = items.map((it, i) => ({ ...it, vector: vectors[i]! }));

const db = await lancedb.connect(outDir);
await db.createTable("support_tickets", rows, { mode: "overwrite" });
console.log(`Wrote ${rows.length} rows with real embeddings (dim=${vectors[0]!.length}) into ${outDir}/support_tickets.lance`);
