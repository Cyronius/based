// Traces: BASED-EMBED-CLUSTER-NAMES — clusters are named from their own words; numbers are the last resort.

/** AI label, else the top two distinctive words, else the 1-based number. */
export function clusterDisplayName(aiLabel: string | undefined, terms: string[] | undefined, c: number): string {
  if (aiLabel) return aiLabel;
  const words = (terms ?? []).filter((t) => t.length >= 3 && !/^\d+$/.test(t)).slice(0, 2);
  return words.length ? words.join(" · ") : String(c + 1);
}

export interface Badge {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Push overlapping badges apart (centers move, sizes fixed), kept inside [0,width]×[0,height]. */
export function separateBadges(badges: Badge[], width: number, height: number, gap = 6, rounds = 40): Badge[] {
  const out = badges.map((b) => ({ ...b }));
  const clamp = (b: Badge) => {
    b.x = Math.min(width - b.w / 2, Math.max(b.w / 2, b.x));
    b.y = Math.min(height - b.h / 2, Math.max(b.h / 2, b.y));
  };
  for (let r = 0; r < rounds; r++) {
    let moved = false;
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        const a = out[i]!;
        const b = out[j]!;
        const ox = (a.w + b.w) / 2 + gap - Math.abs(a.x - b.x);
        const oy = (a.h + b.h) / 2 + gap - Math.abs(a.y - b.y);
        if (ox <= 0 || oy <= 0) continue;
        moved = true;
        // Move along the axis that needs less travel; ties go vertical, which keeps labels readable.
        if (ox < oy) {
          const d = (a.x <= b.x ? -1 : 1) * (ox / 2);
          a.x += d;
          b.x -= d;
        } else {
          const d = (a.y <= b.y ? -1 : 1) * (oy / 2);
          a.y += d;
          b.y -= d;
        }
        clamp(a);
        clamp(b);
      }
    }
    if (!moved) break;
  }
  return out;
}
