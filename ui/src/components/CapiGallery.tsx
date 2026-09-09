// Traces: BASED-CAPI-AVATAR
// Dev gallery: every mood side by side, with the speaking/orange/variant toggles. Mounted by
// main.tsx when the URL has `?capi` — not reachable from the app's UI.
import { useState } from "react";
import { CapiAvatar } from "./CapiAvatar";
import type { Mood } from "../agent/capiMood";

const MOODS: Mood[] = ["idle", "sleepy", "listening", "thinking", "working", "waiting", "talking", "happy", "concerned"];

export function CapiGallery() {
  const [speaking, setSpeaking] = useState(false);
  const [orange, setOrange] = useState(true);
  const [variant, setVariant] = useState<"bust" | "full">("full");
  const [size, setSize] = useState(96);
  const [solo, setSolo] = useState<Mood | null>(null);
  const [tick, setTick] = useState(0);

  const shown = solo ? [solo] : MOODS;
  return (
    <div className="min-h-screen bg-ink-950 p-6 text-paper">
      <div className="mb-6 flex flex-wrap items-center gap-4 text-[length:var(--fs-base)]">
        <span className="font-bold">Capi gallery</span>
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={speaking} onChange={(e) => setSpeaking(e.target.checked)} /> speaking
        </label>
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={orange} onChange={(e) => setOrange(e.target.checked)} /> orange
        </label>
        <label className="flex items-center gap-1.5">
          variant
          <select className="rounded border border-line bg-ink-800 px-1" value={variant} onChange={(e) => setVariant(e.target.value as "bust" | "full")}>
            <option value="bust">bust</option>
            <option value="full">full</option>
          </select>
        </label>
        <label className="flex items-center gap-1.5">
          height
          <input type="range" min={48} max={400} value={size} onChange={(e) => setSize(Number(e.target.value))} />
          <span className="text-muted">{size}px</span>
        </label>
        <label className="flex items-center gap-1.5">
          solo
          <select className="rounded border border-line bg-ink-800 px-1" value={solo ?? ""} onChange={(e) => setSolo((e.target.value || null) as Mood | null)}>
            <option value="">all</option>
            {MOODS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        {/* Remounts the avatars so the mood-entry one-shots (hop, shake) replay. */}
        <button className="rounded border border-line px-2 py-0.5 text-muted hover:text-paper" onClick={() => setTick((t) => t + 1)}>
          replay entry
        </button>
      </div>
      <div className="flex flex-wrap gap-6">
        {shown.map((m) => (
          <div key={m} className="flex flex-col items-center gap-2 rounded-md border border-line-soft bg-ink-900 p-4">
            <div style={{ height: size }}>
              <EntryReplay key={tick} mood={m} speaking={speaking} orange={orange} variant={variant} />
            </div>
            <div className="ledger-label">{m}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// Mount idle, then flip to the target mood on the next frame so the entry animation runs.
function EntryReplay({ mood, ...rest }: { mood: Mood; speaking: boolean; orange: boolean; variant: "bust" | "full" }) {
  const [m, setM] = useState<Mood>("idle");
  if (m !== mood) requestAnimationFrame(() => setM(mood));
  return <CapiAvatar className="h-full w-auto" mood={m} {...rest} />;
}
