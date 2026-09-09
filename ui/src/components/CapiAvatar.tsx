// Traces: BASED-CAPI-AVATAR
// Capi, the capybara. Layered SVG in a 400x520 space; every moving part is its own <g> with a
// `transform-box: fill-box` origin so CSS can animate it (index.css, "Capi avatar"). Expressions
// are slots of stacked poses crossfaded by opacity; eyelids, gaze, ears, head and body are
// transforms. The mood is a prop (derived by `deriveMood` in the chat) — the only randomness left
// here is idle micro-behaviour: blinks, ear twitches, and cursor-following gaze.
import { useCallback, useEffect, useId, useRef, useState, type CSSProperties } from "react";
import type { Mood } from "../agent/capiMood";

type Brows = "neutral" | "raised" | "concerned" | "asym";
type Eyes = "open" | "happy";
type Mouth = "neutral" | "smile" | "frown" | "o";

interface Face {
  brows: Brows;
  eyes: Eyes;
  mouth: Mouth;
  /** Eyelid coverage 0 (open) … 1 (closed). */
  lid: number;
  /** Where the pupils point, each axis -1 … 1. `null` = follow the cursor. */
  gaze: { x: number; y: number } | null;
}

const FACES: Record<Mood, Face> = {
  idle: { brows: "neutral", eyes: "open", mouth: "neutral", lid: 0, gaze: null },
  sleepy: { brows: "neutral", eyes: "open", mouth: "neutral", lid: 0.62, gaze: { x: 0, y: 0.7 } },
  listening: { brows: "raised", eyes: "open", mouth: "smile", lid: 0, gaze: { x: 1, y: 0.25 } },
  thinking: { brows: "asym", eyes: "open", mouth: "o", lid: 0, gaze: { x: -0.7, y: -1 } },
  working: { brows: "neutral", eyes: "open", mouth: "neutral", lid: 0.32, gaze: { x: 0.25, y: 1 } },
  waiting: { brows: "raised", eyes: "open", mouth: "neutral", lid: 0, gaze: { x: 0, y: 0 } },
  talking: { brows: "neutral", eyes: "open", mouth: "smile", lid: 0, gaze: { x: 0.35, y: 0.2 } },
  happy: { brows: "raised", eyes: "happy", mouth: "smile", lid: 0, gaze: { x: 0, y: 0 } },
  concerned: { brows: "concerned", eyes: "open", mouth: "frown", lid: 0.15, gaze: { x: 0, y: 0.35 } },
};

const VIEWBOX = { bust: "36 0 328 330", full: "0 0 400 520" } as const;
const ASPECT = { bust: "328 / 330", full: "400 / 520" } as const;

const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo);

// Blink every few seconds, sometimes twice. Runs for the component's lifetime.
function useBlink(): boolean {
  const [blink, setBlink] = useState(false);
  useEffect(() => {
    let alive = true;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const after = (ms: number, fn: () => void) => timers.push(setTimeout(() => alive && fn(), ms));
    const loop = () =>
      after(rand(2500, 6000), () => {
        setBlink(true);
        after(130, () => setBlink(false));
        if (Math.random() < 0.2) {
          after(310, () => setBlink(true));
          after(440, () => setBlink(false));
        }
        loop();
      });
    loop();
    return () => {
      alive = false;
      timers.forEach(clearTimeout);
    };
  }, []);
  return blink;
}

// One ear flicks every 5–12 s.
function useEarTwitch(): "l" | "r" | null {
  const [side, setSide] = useState<"l" | "r" | null>(null);
  useEffect(() => {
    let alive = true;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const after = (ms: number, fn: () => void) => timers.push(setTimeout(() => alive && fn(), ms));
    const loop = () =>
      after(rand(5000, 12000), () => {
        setSide(Math.random() < 0.5 ? "l" : "r");
        after(380, () => setSide(null));
        loop();
      });
    loop();
    return () => {
      alive = false;
      timers.forEach(clearTimeout);
    };
  }, []);
  return side;
}

// Gaze: the mood's fixed direction, or — when idle — the cursor, wherever it is on the page.
function useGaze(target: { x: number; y: number } | null, el: React.RefObject<HTMLDivElement | null>) {
  const [gaze, setGaze] = useState({ x: 0, y: 0 });
  useEffect(() => {
    if (target) {
      setGaze(target);
      return;
    }
    let raf = 0;
    let last: PointerEvent | null = null;
    const apply = () => {
      raf = 0;
      const box = el.current?.getBoundingClientRect();
      if (!box || !last) return;
      const cx = box.left + box.width / 2;
      const cy = box.top + box.height * 0.4;
      // Saturate at ~250px so a far-away cursor still reads as "looking that way", not cross-eyed.
      const x = Math.max(-1, Math.min(1, (last.clientX - cx) / 250));
      const y = Math.max(-1, Math.min(1, (last.clientY - cy) / 250));
      setGaze({ x, y });
    };
    const onMove = (e: PointerEvent) => {
      last = e;
      if (!raf) raf = requestAnimationFrame(apply);
    };
    window.addEventListener("pointermove", onMove);
    return () => {
      window.removeEventListener("pointermove", onMove);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [target, el]);
  return gaze;
}

// One-shot entry animation when the mood flips to happy (hop) or concerned (shake).
function useEntry(mood: Mood): "hop" | "shake" | null {
  const [entry, setEntry] = useState<"hop" | "shake" | null>(null);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const kind = mood === "happy" ? "hop" : mood === "concerned" ? "shake" : null;
    setEntry(kind);
    if (!kind) return;
    const t = setTimeout(() => setEntry(null), 900);
    return () => clearTimeout(t);
  }, [mood]);
  return entry;
}

/**
 * Milliseconds since the last `touch()` or change of `resetKey`, sampled every 15 s. For the
 * sleepy threshold only — coarse on purpose so pointer activity doesn't re-render anything.
 */
export function useIdleMs(resetKey: unknown): { idleMs: number; touch: () => void } {
  const sinceRef = useRef(Date.now());
  const [idleMs, setIdleMs] = useState(0);
  useEffect(() => {
    sinceRef.current = Date.now();
    setIdleMs(0);
  }, [resetKey]);
  useEffect(() => {
    const t = setInterval(() => setIdleMs(Date.now() - sinceRef.current), 15_000);
    return () => clearInterval(t);
  }, []);
  const touch = useCallback(() => {
    sinceRef.current = Date.now();
    setIdleMs((v) => (v === 0 ? v : 0));
  }, []);
  return { idleMs, touch };
}

function Pose({ active, children, className }: { active: boolean; children: React.ReactNode; className?: string }) {
  return <g className={`capy-pose${active ? " active" : ""}${className ? ` ${className}` : ""}`}>{children}</g>;
}

const INK = "#3B2A1E";

export interface CapiAvatarProps {
  mood?: Mood;
  /** Text is arriving right now — flaps the mouth. */
  speaking?: boolean;
  /** `full` is the whole body (what the app uses); `bust` crops to head and shoulders. */
  variant?: "bust" | "full";
  /** The orange on his head. */
  orange?: boolean;
  className?: string;
}

export function CapiAvatar({ mood = "idle", speaking = false, variant = "full", orange = true, className }: CapiAvatarProps) {
  const face = FACES[mood];
  const rootRef = useRef<HTMLDivElement>(null);
  const blink = useBlink();
  const twitch = useEarTwitch();
  const gaze = useGaze(face.gaze, rootRef);
  const entry = useEntry(mood);
  const uid = useId().replace(/:/g, "");
  const fur = `url(#${uid}-fur)`;
  const muzzle = `url(#${uid}-muzzle)`;
  const orangeFill = `url(#${uid}-orange)`;

  const classes = [
    "capy",
    `capy-mood-${mood}`,
    `capy-variant-${variant}`,
    speaking && mood !== "concerned" ? "capy-speaking" : "",
    blink ? "capy-blink" : "",
    twitch ? `capy-twitch-${twitch}` : "",
    entry ? `capy-enter-${entry}` : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  const style = {
    aspectRatio: ASPECT[variant],
    "--gx": gaze.x,
    "--gy": gaze.y,
    "--lid": face.lid,
  } as CSSProperties;

  return (
    <div ref={rootRef} className={classes} style={style} data-mood={mood}>
      <svg viewBox={VIEWBOX[variant]} className="h-full w-full" aria-hidden="true">
        <defs>
          <radialGradient id={`${uid}-fur`} cx="42%" cy="28%" r="80%">
            <stop offset="0" stopColor="#EDB978" />
            <stop offset="0.55" stopColor="#DDA05F" />
            <stop offset="1" stopColor="#B87E43" />
          </radialGradient>
          <radialGradient id={`${uid}-muzzle`} cx="50%" cy="25%" r="75%">
            <stop offset="0" stopColor="#CB935B" />
            <stop offset="1" stopColor="#A26F40" />
          </radialGradient>
          <radialGradient id={`${uid}-orange`} cx="38%" cy="32%" r="70%">
            <stop offset="0" stopColor="#FFB640" />
            <stop offset="0.7" stopColor="#F28C1B" />
            <stop offset="1" stopColor="#C96A0C" />
          </radialGradient>
        </defs>

        <g className="capy-part capy-root">
          {/* ground shadow + body — only meaningful in the full variant, harmless cropped */}
          <ellipse cx={200} cy={500} rx={150} ry={13} fill="#000" opacity={0.22} />
          <g className="capy-part capy-body">
            <ellipse cx={120} cy={486} rx={27} ry={15} fill="#7A4B2A" stroke={INK} strokeWidth={3} />
            <ellipse cx={280} cy={486} rx={27} ry={15} fill="#7A4B2A" stroke={INK} strokeWidth={3} />
            <path
              d="M118,300 C80,340 66,410 80,455 C92,486 140,500 200,500 C260,500 308,486 320,455 C334,410 320,340 282,300 Z"
              fill={fur}
              stroke={INK}
              strokeWidth={3}
              strokeLinejoin="round"
            />
            <ellipse cx={200} cy={432} rx={66} ry={46} fill="#EDBE86" opacity={0.45} />
            <ellipse cx={166} cy={493} rx={25} ry={14} fill="#7A4B2A" stroke={INK} strokeWidth={3} />
            <ellipse cx={234} cy={493} rx={25} ry={14} fill="#7A4B2A" stroke={INK} strokeWidth={3} />
            {/* toes */}
            <g stroke={INK} strokeWidth={2} strokeLinecap="round" opacity={0.7}>
              <path d="M158,499 v6 M166,500 v6 M174,499 v6" />
              <path d="M226,499 v6 M234,500 v6 M242,499 v6" />
            </g>
          </g>

          <g className="capy-part capy-head">
            {/* ears (behind the head shape) */}
            <g className="capy-part capy-ear capy-ear-l">
              <g transform="rotate(-20 112 96)">
                <ellipse cx={112} cy={72} rx={29} ry={36} fill="#CB8F52" stroke={INK} strokeWidth={3} />
                <ellipse cx={113} cy={76} rx={17} ry={24} fill="#6E4A2C" />
                <ellipse cx={116} cy={72} rx={9} ry={14} fill="#8A5E3A" opacity={0.6} />
              </g>
            </g>
            <g className="capy-part capy-ear capy-ear-r">
              <g transform="rotate(20 288 96)">
                <ellipse cx={288} cy={72} rx={29} ry={36} fill="#CB8F52" stroke={INK} strokeWidth={3} />
                <ellipse cx={287} cy={76} rx={17} ry={24} fill="#6E4A2C" />
                <ellipse cx={284} cy={72} rx={9} ry={14} fill="#8A5E3A" opacity={0.6} />
              </g>
            </g>

            {/* head */}
            <path
              d="M200,58 C130,58 78,100 66,165 C58,215 68,272 104,306 C132,332 268,332 296,306 C332,272 342,215 334,165 C322,100 270,58 200,58 Z"
              fill={fur}
              stroke={INK}
              strokeWidth={3}
              strokeLinejoin="round"
            />
            {/* crown + cheek tufts */}
            <g stroke={INK} strokeWidth={3} strokeLinecap="round" fill="none" opacity={0.85}>
              <path d="M186,60 Q180,48 184,38" />
              <path d="M202,57 Q204,44 200,34" />
              <path d="M218,60 Q224,48 222,38" />
              <path d="M70,232 Q56,236 50,246" />
              <path d="M72,252 Q58,258 54,268" />
              <path d="M330,232 Q344,236 350,246" />
              <path d="M328,252 Q342,258 346,268" />
            </g>

            {orange && (
              <g className="capy-orange">
                <circle cx={158} cy={50} r={21} fill={orangeFill} stroke={INK} strokeWidth={3} />
                <circle cx={150} cy={42} r={5} fill="#FFF" opacity={0.35} />
                <circle cx={158} cy={50} r={1.6} fill={INK} opacity={0.5} />
                <path d="M158,30 q1,-6 4,-9" stroke="#4E7A2E" strokeWidth={3} strokeLinecap="round" fill="none" />
                <path d="M162,25 q10,-6 16,2 q-9,6 -16,-2 Z" fill="#6AA542" stroke="#3F6B25" strokeWidth={2} strokeLinejoin="round" />
              </g>
            )}

            {/* cheeks */}
            <g opacity={0.45}>
              <ellipse cx={98} cy={242} rx={21} ry={11} fill="#F0A98A" />
              <ellipse cx={302} cy={242} rx={21} ry={11} fill="#F0A98A" />
            </g>

            {/* eyebrows */}
            <g stroke={INK} strokeWidth={6} fill="none" strokeLinecap="round">
              <Pose active={face.brows === "neutral"}>
                <path d="M112,142 Q138,131 164,142" />
                <path d="M236,142 Q262,131 288,142" />
              </Pose>
              <Pose active={face.brows === "raised"}>
                <path d="M112,132 Q138,116 164,130" />
                <path d="M236,130 Q262,116 288,132" />
              </Pose>
              <Pose active={face.brows === "concerned"}>
                <path d="M112,138 Q138,136 166,148" />
                <path d="M234,148 Q262,136 288,138" />
              </Pose>
              <Pose active={face.brows === "asym"}>
                <path d="M112,144 Q138,135 164,144" />
                <path d="M236,128 Q262,112 288,128" />
              </Pose>
            </g>

            {/* eyes */}
            <Pose active={face.eyes === "open"}>
              {[138, 262].map((cx) => (
                <g key={cx}>
                  <circle cx={cx} cy={178} r={20} fill="#4A3323" />
                  <g className="capy-part capy-pupil">
                    <circle cx={cx} cy={178} r={13} fill="#1C1410" />
                    <circle cx={cx - 5} cy={172} r={5.5} fill="#FFF" />
                    <circle cx={cx + 6} cy={185} r={2.6} fill="#FFF" opacity={0.75} />
                  </g>
                  <ellipse className="capy-part capy-lid" cx={cx} cy={178} rx={22} ry={22} fill="#D99A5A" />
                </g>
              ))}
            </Pose>
            <Pose active={face.eyes === "happy"}>
              <g stroke={INK} strokeWidth={6} fill="none" strokeLinecap="round">
                <path d="M118,182 Q138,158 158,182" />
                <path d="M242,182 Q262,158 282,182" />
              </g>
            </Pose>

            {/* muzzle */}
            <path
              d="M170,212 H230 C246,212 252,222 252,236 V280 C252,294 240,300 200,300 C160,300 148,294 148,280 V236 C148,222 154,212 170,212 Z"
              fill={muzzle}
              stroke={INK}
              strokeWidth={3}
              strokeLinejoin="round"
            />
            <ellipse cx={200} cy={228} rx={24} ry={8} fill="#FFF" opacity={0.12} />
            <g stroke={INK} strokeWidth={5} strokeLinecap="round" fill="none">
              <path d="M184,238 q-7,8 1,15" />
              <path d="M216,238 q7,8 -1,15" />
            </g>
            {/* whisker dots */}
            <g fill={INK} opacity={0.55}>
              <circle cx={128} cy={256} r={2.6} />
              <circle cx={122} cy={268} r={2.6} />
              <circle cx={130} cy={280} r={2.6} />
              <circle cx={272} cy={256} r={2.6} />
              <circle cx={278} cy={268} r={2.6} />
              <circle cx={270} cy={280} r={2.6} />
            </g>

            {/* mouth */}
            <g stroke={INK} strokeWidth={4} fill="none" strokeLinecap="round">
              <Pose active={face.mouth === "neutral"}>
                <path d="M176,274 Q188,286 200,276 Q212,286 224,274" />
              </Pose>
              <Pose active={face.mouth === "smile"}>
                <path d="M172,270 Q200,298 228,270" />
              </Pose>
              <Pose active={face.mouth === "frown"}>
                <path d="M176,284 Q200,268 224,284" />
              </Pose>
              <Pose active={face.mouth === "o"}>
                <ellipse cx={200} cy={280} rx={6} ry={7.5} fill={INK} stroke="none" />
              </Pose>
              <Pose active={false} className="capy-mouth-open">
                <path d="M178,270 Q200,272 222,270 Q220,296 200,298 Q180,296 178,270 Z" fill="#5A2C28" stroke={INK} />
                <ellipse cx={200} cy={291} rx={9} ry={5} fill="#D9736E" stroke="none" />
              </Pose>
            </g>
          </g>

          {/* thought dots (thinking) */}
          <g className="capy-dots" fill={fur} stroke={INK} strokeWidth={2.5}>
            <circle cx={300} cy={60} r={5} />
            <circle cx={318} cy={42} r={7} />
            <circle cx={341} cy={22} r={9.5} />
          </g>
          {/* zzz (sleepy) */}
          <g className="capy-zzz" fill={INK} fontFamily="ui-sans-serif, system-ui, sans-serif" fontWeight={800}>
            <text x={296} y={70} fontSize={22}>z</text>
            <text x={314} y={46} fontSize={28}>z</text>
            <text x={338} y={20} fontSize={34}>z</text>
          </g>
        </g>
      </svg>
    </div>
  );
}
