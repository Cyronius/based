// Throwaway seed script for based screenshot capture. Creates a local LanceDB with a
// "support tickets" table: obviously-synthetic text, embeddings with real cluster structure
// (Gaussian blobs per topic) so the Embeddings Atlas has something to converge into. Not part
// of the test suite -- run directly with `bun run specs/_seed-lance-demo.ts <outDir>` and
// delete when screenshot capture is done.
import * as lancedb from "@lancedb/lancedb";

const outDir = process.argv[2];
if (!outDir) {
  console.error("usage: bun run specs/_seed-lance-demo.ts <outDir>");
  process.exit(1);
}

const DIM = 32;

// Deterministic PRNG so re-runs are stable.
let seed = 20260726;
function rand(): number {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}
function gaussian(): number {
  const u = 1 - rand();
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const TOPICS = [
  {
    category: "Billing",
    centroid: () => Array.from({ length: DIM }, (_, i) => Math.sin(i * 0.31) * 3),
    templates: [
      "Customer was charged twice for the {plan} plan renewal on {date}.",
      "Invoice #{n} shows an incorrect tax amount for the {plan} subscription.",
      "Requesting a refund for the {plan} plan -- cancelled before the trial ended.",
      "Credit card on file expired; billing retry for {plan} failed on {date}.",
      "Customer asking to switch from monthly to annual {plan} billing.",
    ],
  },
  {
    category: "Login / Auth",
    centroid: () => Array.from({ length: DIM }, (_, i) => Math.cos(i * 0.47) * 3 + 2),
    templates: [
      "User locked out after {n} failed login attempts, needs manual unlock.",
      "SSO redirect loops back to the login page without an error message.",
      "Password reset email never arrives for the {domain} domain.",
      "Two-factor code from the authenticator app is rejected every time.",
      "Session expires within a minute of logging in on {browser}.",
    ],
  },
  {
    category: "Performance",
    centroid: () => Array.from({ length: DIM }, (_, i) => Math.sin(i * 0.19 + 1) * 3 - 2),
    templates: [
      "Dashboard takes over {n} seconds to load for the {plan} tenant.",
      "Bulk export of {n} rows times out around the 60s mark.",
      "Search results lag noticeably after the last release on {date}.",
      "CPU usage spikes to 100% when switching between large tabs.",
      "Sync between devices is delayed by several minutes intermittently.",
    ],
  },
  {
    category: "Data Export",
    centroid: () => Array.from({ length: DIM }, (_, i) => Math.cos(i * 0.61 + 2) * 3 + 4),
    templates: [
      "CSV export drops the last {n} rows on large tables.",
      "XLSX export corrupts special characters in the {domain} column.",
      "Scheduled export to the {domain} bucket silently stopped on {date}.",
      "Requesting a way to export only rows changed since {date}.",
      "PDF export of the report is missing the summary chart.",
    ],
  },
  {
    category: "Mobile App",
    centroid: () => Array.from({ length: DIM }, (_, i) => Math.sin(i * 0.83 + 3) * 3 - 4),
    templates: [
      "App crashes on launch on {browser} after the {date} update.",
      "Push notifications stopped arriving for {plan} tier users.",
      "Offline mode doesn't sync changes back once reconnected.",
      "Dark mode toggle has no effect on the settings screen.",
      "Camera permission prompt loops without ever granting access.",
    ],
  },
  {
    category: "Feature Request",
    centroid: () => Array.from({ length: DIM }, (_, i) => Math.cos(i * 0.29 + 4) * 3),
    templates: [
      "Would like bulk-tagging support for the {domain} workspace.",
      "Request: keyboard shortcut for duplicating a row.",
      "Asking for a dark theme option matching the {domain} brand colors.",
      "Feature request: webhook on {plan} plan changes.",
      "Would like an audit log export scoped to a single user.",
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
const rows: Array<{ id: number; category: string; text: string; priority: string; vector: number[] }> = [];
let id = 0;
for (const topic of TOPICS) {
  const centroid = topic.centroid();
  for (let i = 0; i < PER_TOPIC; i++) {
    const vector = centroid.map((c) => c + gaussian() * 0.9);
    const template = topic.templates[i % topic.templates.length]!;
    rows.push({
      id: id++,
      category: topic.category,
      text: fill(template, i),
      priority: i % 9 === 0 ? "high" : i % 3 === 0 ? "medium" : "low",
      vector,
    });
  }
}

const db = await lancedb.connect(outDir);
await db.createTable("support_tickets", rows, { mode: "overwrite" });
console.log(`Seeded ${rows.length} rows (${TOPICS.length} topics, dim=${DIM}) into ${outDir}/support_tickets.lance`);
