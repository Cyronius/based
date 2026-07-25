// Animated capybara avatar for "Ask Capi" — layered SVG art adapted from
// shell/assets/capi/capy-demo.html. Body/head/ears are static; eyebrows,
// eyes, and mouth are each a "slot" of stacked poses crossfaded via opacity.
import {
  Children,
  cloneElement,
  isValidElement,
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";

type Eyebrows = "neutral" | "raised" | "concerned";
type Eyes = "neutral" | "thinking" | "searching" | "happy";
type Mouth = "neutral" | "smile" | "frown";

interface Preset {
  eyebrows: Eyebrows;
  eyes: Eyes;
  mouth: Mouth;
}

type PresetKey = "neutral" | "thinking" | "curious" | "content" | "concerned";

const PRESETS: Record<PresetKey, Preset> = {
  neutral: { eyebrows: "neutral", eyes: "neutral", mouth: "neutral" },
  thinking: { eyebrows: "neutral", eyes: "thinking", mouth: "neutral" },
  curious: { eyebrows: "raised", eyes: "searching", mouth: "neutral" },
  content: { eyebrows: "neutral", eyes: "happy", mouth: "smile" },
  concerned: { eyebrows: "concerned", eyes: "neutral", mouth: "frown" },
};

// Weighted so "neutral" dominates — Capy mostly just sits there.
const PRESET_WEIGHTS: [PresetKey, number][] = [
  ["neutral", 10],
  ["thinking", 2],
  ["curious", 2],
  ["content", 2],
  ["concerned", 1],
];

const MIN_DELAY_MS = 30_000;
const MAX_DELAY_MS = 90_000;

function randomDelay(): number {
  return MIN_DELAY_MS + Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS);
}

// Placeholder: expression is randomized for now. Once Capi's chat/agent state
// is wired in, this should react to real events (thinking while awaiting a
// response, concerned on error, etc.) instead of picking at random.
function pickNextPreset(current: PresetKey): PresetKey {
  const options = PRESET_WEIGHTS.filter(([key]) => key !== current);
  const total = options.reduce((sum, [, weight]) => sum + weight, 0);
  let roll = Math.random() * total;
  for (const [key, weight] of options) {
    roll -= weight;
    if (roll <= 0) return key;
  }
  return options[options.length - 1][0];
}

function ExpressionSlot({ id, active, children }: { id: string; active: string; children: ReactNode }) {
  return (
    <g id={id}>
      {Children.map(children, (child) => {
        if (!isValidElement(child)) return child;
        const el = child as ReactElement<{ "data-state"?: string; className?: string }>;
        const isActive = el.props["data-state"] === active;
        return cloneElement(el, { className: isActive ? "capy-slot-pose active" : "capy-slot-pose" });
      })}
    </g>
  );
}

export function CapiAvatar({ className }: { className?: string }) {
  const [presetKey, setPresetKey] = useState<PresetKey>("neutral");
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    const schedule = () => {
      timeoutRef.current = setTimeout(() => {
        setPresetKey((current) => pickNextPreset(current));
        schedule();
      }, randomDelay());
    };
    schedule();
    return () => clearTimeout(timeoutRef.current);
  }, []);

  const preset = PRESETS[presetKey];

  return (
    <div className={`${className ?? ""} capy-breathe`} style={{ aspectRatio: "400 / 520" }}>
      <svg viewBox="0 0 400 520" className="h-full w-full" aria-hidden="true">
        {/* body.svg */}
        <path
          d="M90,220 C52,265 42,350 62,412 C78,452 125,472 200,472 C275,472 322,452 338,412 C358,350 348,265 310,220 C295,250 255,268 200,270 C145,268 105,250 90,220 Z"
          fill="#DDA05F"
          stroke="#3B2A1E"
          strokeWidth={4}
          strokeLinejoin="round"
        />
        <ellipse cx={108} cy={458} rx={27} ry={20} fill="#7A4B2A" stroke="#3B2A1E" strokeWidth={4} />
        <ellipse cx={292} cy={458} rx={27} ry={20} fill="#7A4B2A" stroke="#3B2A1E" strokeWidth={4} />
        <path
          d="M112,295 C104,345 108,405 134,450 C140,460 152,462 158,454 C166,410 162,345 152,295 Z"
          fill="#DDA05F"
        />
        <path
          d="M112,295 C104,345 108,405 134,450 C140,460 152,462 158,454 C166,410 162,345 152,295"
          fill="none"
          stroke="#3B2A1E"
          strokeWidth={4}
          strokeLinecap="round"
        />
        <path
          d="M288,295 C296,345 292,405 266,450 C260,460 248,462 242,454 C234,410 238,345 248,295 Z"
          fill="#DDA05F"
        />
        <path
          d="M288,295 C296,345 292,405 266,450 C260,460 248,462 242,454 C234,410 238,345 248,295"
          fill="none"
          stroke="#3B2A1E"
          strokeWidth={4}
          strokeLinecap="round"
        />
        <ellipse cx={150} cy={460} rx={24} ry={18} fill="#7A4B2A" stroke="#3B2A1E" strokeWidth={4} />
        <ellipse cx={250} cy={460} rx={24} ry={18} fill="#7A4B2A" stroke="#3B2A1E" strokeWidth={4} />

        {/* head.svg */}
        <g transform="rotate(-15 118 55)">
          <ellipse cx={118} cy={55} rx={34} ry={44} fill="#CB8F52" stroke="#3B2A1E" strokeWidth={4} />
          <ellipse cx={118} cy={58} rx={17} ry={25} fill="#4A3323" />
        </g>
        <g transform="rotate(12 282 50)">
          <ellipse cx={282} cy={50} rx={32} ry={42} fill="#CB8F52" stroke="#3B2A1E" strokeWidth={4} />
          <ellipse cx={282} cy={53} rx={16} ry={23} fill="#4A3323" />
        </g>
        <path
          d="M200,30 C140,30 95,55 80,110 C68,155 70,205 90,235 C110,268 155,285 200,285 C245,285 290,268 310,235 C330,205 332,155 320,110 C305,55 260,30 200,30 Z"
          fill="#DDA05F"
          stroke="#3B2A1E"
          strokeWidth={4}
          strokeLinejoin="round"
        />
        <path
          d="M150,160 C140,190 145,225 200,232 C255,225 260,190 250,160 C245,130 155,130 150,160 Z"
          fill="#A97850"
          stroke="#3B2A1E"
          strokeWidth={3.5}
          strokeLinejoin="round"
        />
        <ellipse cx={188} cy={182} rx={4} ry={6} fill="#3B2A1E" />
        <ellipse cx={212} cy={182} rx={4} ry={6} fill="#3B2A1E" />
        <g opacity={0.65}>
          <ellipse cx={128} cy={185} rx={20} ry={11} fill="#F0A98A" />
          <ellipse cx={272} cy={185} rx={20} ry={11} fill="#F0A98A" />
        </g>

        <ExpressionSlot id="slot-eyebrows" active={preset.eyebrows}>
          <g data-state="neutral">
            <path d="M123,120 Q143,112 163,120" stroke="#3B2A1E" strokeWidth={5} fill="none" strokeLinecap="round" />
            <path d="M237,116 Q257,108 277,116" stroke="#3B2A1E" strokeWidth={5} fill="none" strokeLinecap="round" />
          </g>
          <g data-state="raised">
            <path d="M123,116 Q143,104 163,116" stroke="#3B2A1E" strokeWidth={5} fill="none" strokeLinecap="round" />
            <path d="M237,112 Q257,100 277,112" stroke="#3B2A1E" strokeWidth={5} fill="none" strokeLinecap="round" />
          </g>
          <g data-state="concerned">
            <path d="M123,118 Q143,116 164,124" stroke="#3B2A1E" strokeWidth={5} fill="none" strokeLinecap="round" />
            <path d="M236,124 Q257,116 277,118" stroke="#3B2A1E" strokeWidth={5} fill="none" strokeLinecap="round" />
          </g>
        </ExpressionSlot>

        <ExpressionSlot id="slot-eyes" active={preset.eyes}>
          <g data-state="neutral">
            <circle cx={143} cy={150} r={13} fill="#3B2A1E" />
            <circle cx={139} cy={145} r={4} fill="#FFFFFF" />
            <circle cx={257} cy={145} r={13} fill="#3B2A1E" />
            <circle cx={253} cy={140} r={4} fill="#FFFFFF" />
          </g>
          <g data-state="thinking">
            <circle cx={142} cy={148} r={13} fill="#3B2A1E" />
            <circle cx={138} cy={142} r={4} fill="#FFFFFF" />
            <circle cx={256} cy={143} r={13} fill="#3B2A1E" />
            <circle cx={252} cy={138} r={4} fill="#FFFFFF" />
            <path
              d="M130,140 Q143,135 156,140"
              stroke="#3B2A1E"
              strokeWidth={2}
              fill="none"
              opacity={0.35}
              strokeLinecap="round"
            />
            <path
              d="M244,135 Q257,130 270,135"
              stroke="#3B2A1E"
              strokeWidth={2}
              fill="none"
              opacity={0.35}
              strokeLinecap="round"
            />
          </g>
          <g data-state="searching">
            <circle cx={143} cy={150} r={13} fill="#3B2A1E" />
            <circle cx={147} cy={146} r={4} fill="#FFFFFF" />
            <circle cx={257} cy={145} r={13} fill="#3B2A1E" />
            <circle cx={261} cy={141} r={4} fill="#FFFFFF" />
          </g>
          <g data-state="happy">
            <ellipse cx={143} cy={151} rx={13} ry={11} fill="#3B2A1E" />
            <circle cx={139} cy={147} r={4} fill="#FFFFFF" />
            <ellipse cx={257} cy={146} rx={13} ry={11} fill="#3B2A1E" />
            <circle cx={253} cy={142} r={4} fill="#FFFFFF" />
          </g>
        </ExpressionSlot>

        <ExpressionSlot id="slot-mouth" active={preset.mouth}>
          <g data-state="neutral">
            <path
              d="M175,205 Q187,215 200,205 Q213,215 225,205"
              stroke="#3B2A1E"
              strokeWidth={4}
              fill="none"
              strokeLinecap="round"
            />
          </g>
          <g data-state="smile">
            <path
              d="M173,202 Q187,217 200,205 Q213,217 227,202"
              stroke="#3B2A1E"
              strokeWidth={4}
              fill="none"
              strokeLinecap="round"
            />
          </g>
          <g data-state="frown">
            <path
              d="M175,207 Q187,213 200,208 Q213,213 225,207"
              stroke="#3B2A1E"
              strokeWidth={4}
              fill="none"
              strokeLinecap="round"
            />
          </g>
        </ExpressionSlot>
      </svg>
    </div>
  );
}
