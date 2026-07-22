// Traces: BASED-THEME
// Compact theme switcher mounted in the LeftRail header. Lists all themes grouped dark/light with a
// live swatch; selecting one applies + persists it via the store.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { THEMES, type ThemeDef } from "../theme";

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

export function ThemePicker() {
  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);
  const [open, setOpen] = useState(false);
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

  const dark = THEMES.filter((t) => t.mode === "dark");
  const light = THEMES.filter((t) => t.mode === "light");

  const Group = ({ label, items }: { label: string; items: ThemeDef[] }) => (
    <div>
      <div className="ledger-label px-3 pt-2 pb-1">{label}</div>
      {items.map((t) => (
        <button
          key={t.id}
          className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left hover:bg-ink-800 ${
            t.id === theme ? "text-brass" : "text-paper-dim"
          }`}
          onClick={() => {
            setTheme(t.id);
            setOpen(false);
          }}
        >
          <Swatch t={t} />
          <span className="flex-1 truncate text-[12px]">{t.label}</span>
          {t.from && <span className="text-[9px] text-faint">↩ {t.from}</span>}
          {t.id === theme && <span className="text-[11px]">✓</span>}
        </button>
      ))}
    </div>
  );

  return (
    <div className="relative" ref={ref}>
      <button
        ref={btnRef}
        className="text-faint hover:text-brass text-[13px] leading-none"
        title="Theme"
        onClick={() => setOpen((v) => !v)}
      >
        ◐
      </button>
      {open && (
        <div
          className="fixed z-40 max-h-[70vh] w-60 overflow-auto rounded border border-line bg-ink-850 shadow-xl shadow-black/40 fade-up"
          style={{ top: pos.top, left: pos.left }}
        >
          <Group label="Dark" items={dark} />
          <div className="my-1 border-t border-line-soft" />
          <Group label="Light" items={light} />
        </div>
      )}
    </div>
  );
}
