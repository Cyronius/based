// Traces: BASED-THEME, BASED-FONT-SCALE
// Settings popover mounted in the LeftRail header: General (font-size scale) and Theme (color
// theme picker) tabs. Selecting a theme applies + persists it via the store; the font-size slider
// applies live on every drag and persists on release.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { THEMES, type ThemeDef, type ThemeMode } from "../theme";

function Swatch({ t }: { t: ThemeDef }) {
  const k = t.tokens;
  return (
    <span className="inline-flex shrink-0 items-center rounded-sm overflow-hidden border border-black/20" style={{ width: 34, height: 16 }}>
      <span style={{ background: k.bg1, width: 12, height: "100%" }} />
      <span style={{ background: k.bg2, width: 10, height: "100%" }} />
      <span style={{ background: k.accent, width: 6, height: "100%" }} />
      <span style={{ background: k.ok, width: 6, height: "100%" }} />
    </span>
  );
}

type Group = "dark" | "midtone" | "light";

const GROUPS: Array<{ id: Group; label: string }> = [
  { id: "dark", label: "Dark" },
  { id: "midtone", label: "Midtone" },
  { id: "light", label: "Light" },
];

function groupOf(t: ThemeDef): Group {
  if (t.tone === "midtone") return "midtone";
  return t.mode as ThemeMode as Group;
}

function GeneralTab() {
  const fontScale = useStore((s) => s.fontScale);
  const setFontScale = useStore((s) => s.setFontScale);

  return (
    <div className="px-3 py-3 space-y-2">
      <div className="ledger-label">Font size</div>
      <input
        type="range"
        min={0.85}
        max={2.0}
        step={0.05}
        value={fontScale}
        onChange={(e) => setFontScale(Number(e.target.value))}
        className="w-full accent-(--color-brass)"
      />
      <div className="flex items-center justify-between text-[length:var(--fs-sm)] text-faint">
        <span>Small</span>
        <span className="text-paper-dim font-mono">{Math.round(fontScale * 100)}%</span>
        <span>Large</span>
      </div>
    </div>
  );
}

function ThemeTab() {
  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);
  const active = THEMES.find((t) => t.id === theme);
  const [group, setGroup] = useState<Group>(active ? groupOf(active) : "dark");

  const items = THEMES.filter((t) => groupOf(t) === group);

  return (
    <div className="py-2">
      <div className="px-3 pb-2">
        <select
          className="w-full px-2 py-1.5 rounded border border-line bg-ink-900 text-paper text-[length:var(--fs-base)] focus:outline-none focus:border-brass-soft"
          value={group}
          onChange={(e) => setGroup(e.target.value as Group)}
        >
          {GROUPS.map((g) => (
            <option key={g.id} value={g.id}>
              {g.label}
            </option>
          ))}
        </select>
      </div>
      {items.map((t) => (
        <button
          key={t.id}
          className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left hover:bg-ink-800 ${
            t.id === theme ? "text-brass" : "text-paper-dim"
          }`}
          onClick={() => setTheme(t.id)}
        >
          <Swatch t={t} />
          <span className="flex-1 truncate text-[length:var(--fs-base)]">{t.label}</span>
          {t.id === theme && <span className="text-[length:var(--fs-sm)]">✓</span>}
        </button>
      ))}
    </div>
  );
}

export function ThemePicker() {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"general" | "theme">("general");
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const ref = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const MENU_WIDTH = 240;

  useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    const rect = btnRef.current.getBoundingClientRect();
    const left = Math.min(
      Math.max(16, rect.right - MENU_WIDTH),
      window.innerWidth - MENU_WIDTH - 16
    );
    setPos({ top: rect.bottom + 4, left });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const tabBtn = (id: "general" | "theme", label: string) => (
    <button
      className={`flex-1 px-3 py-1.5 text-[length:var(--fs-sm)] font-bold ${
        tab === id ? "text-brass border-b-2 border-brass" : "text-faint border-b-2 border-transparent hover:text-paper-dim"
      }`}
      onClick={() => setTab(id)}
    >
      {label}
    </button>
  );

  return (
    <div className="relative" ref={ref}>
      <button
        ref={btnRef}
        className="text-faint hover:text-brass text-[length:var(--fs-md)] leading-none"
        title="Settings"
        onClick={() => setOpen((v) => !v)}
      >
        ◐
      </button>
      {open && (
        <div
          className="fixed z-40 max-h-[70vh] w-60 overflow-auto rounded border border-line bg-ink-850 shadow-xl shadow-black/40 fade-up"
          style={{ top: pos.top, left: pos.left }}
        >
          <div className="flex border-b border-line-soft">
            {tabBtn("general", "General")}
            {tabBtn("theme", "Theme")}
          </div>
          {tab === "general" ? <GeneralTab /> : <ThemeTab />}
        </div>
      )}
    </div>
  );
}
