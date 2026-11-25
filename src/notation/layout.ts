import type { NotatedMeasure, NotatedSystem } from './types';

/** Target usable horizontal weight per system (matches A4 printable staffwidth). */
export const TARGET_SYSTEM_WEIGHT = 640;

const FIRST_SYSTEM_BASE_HEADER = 70;
const OTHER_SYSTEM_BASE_HEADER = 48;
const KEY_ACCIDENTAL_WEIGHT = 8.5;
const MAX_BARS_PER_SYSTEM = 4;
const MAX_SYSTEM_OVERFLOW_RATIO = 1.06;

/**
 * Estimates the horizontal width demand of a single measure in ABC coordinate units.
 * Accounts for fingering label widths (Helvetica 10.5px, with extra allowance on sub-eighth
 * notes where abcjs allocates tighter spacing), accidentals, note durations, and inline
 * key/meter changes.
 */
function estimateMeasureWeight(measure: NotatedMeasure, fingeringWeightScale = 1): number {
  let w = 20; // barline + padding

  if (measure.hasKeyChange) w += 42;
  if (measure.hasMeterChange) w += 24;

  for (const el of measure.elements) {
    if (el.kind === 'rest') {
      w += el.writtenTicks >= 960 ? 32 : 20;
      continue;
    }

    let noteW: number;
    if (el.writtenTicks >= 960) {
      noteW = 34;
    } else if (el.writtenTicks >= 480) {
      noteW = 26;
    } else if (el.writtenTicks >= 240) {
      noteW = 21;
    } else {
      noteW = 18;
    }

    if (el.printedAccidental !== null) {
      noteW += 10;
    }

    if (el.fingering !== null) {
      // Helvetica 10.5px averages ~6.4 SVG units per character plus inter-label breathing room.
      // Sub-eighth notes receive narrower musical spacing in abcjs, so dense labels there need
      // slightly more weight to prevent crowding.
      const subEighthFactor = el.writtenTicks < 240 ? 1.22 : 1.0;
      const labelW = (el.fingering.length * 6.4 + 8) * subEighthFactor * fingeringWeightScale;
      noteW = Math.max(noteW, labelW);
    }

    w += noteW;
  }

  return w;
}

function endsWithTie(measure: NotatedMeasure): boolean {
  for (let i = measure.elements.length - 1; i >= 0; i--) {
    const el = measure.elements[i]!;
    if (el.kind === 'note') return el.tiedToNext;
  }
  return false;
}

function measureHasFingerings(measure: NotatedMeasure): boolean {
  return measure.elements.some((el) => el.kind === 'note' && el.fingering !== null);
}

function systemHeaderWeight(startIndex: number, measures: readonly NotatedMeasure[]): number {
  const base = startIndex === 0 ? FIRST_SYSTEM_BASE_HEADER : OTHER_SYSTEM_BASE_HEADER;
  const keyAcc = Math.abs(measures[startIndex]?.keyFifths ?? 0);
  return base + keyAcc * KEY_ACCIDENTAL_WEIGHT;
}

interface PartitionSolution {
  cost: number;
  breaks: Array<[number, number]>;
}

/**
 * Partitions whole measures into evenly balanced systems using dynamic programming.
 * - Never breaks inside a measure.
 * - Accounts for key-signature width on every system header.
 * - Balances visual density across systems so bars of similar content get similar widths
 *   and prefer equal bar counts.
 * - Avoids single-bar systems unless a bar truly cannot share with a neighbor.
 * - Prefers not breaking across barline ties when avoidable.
 */
export function layoutSystems(
  measures: NotatedMeasure[],
  weightBoosts: readonly number[] | number = 1,
): NotatedSystem[] {
  const n = measures.length;
  if (n === 0) return [];

  const weights = measures.map((m, i) => {
    const boost = typeof weightBoosts === 'number' ? weightBoosts : (weightBoosts[i] ?? 1);
    return estimateMeasureWeight(m, boost);
  });

  const prefix = new Array<number>(n + 1).fill(0);
  for (let i = 0; i < n; i++) {
    prefix[i + 1] = prefix[i]! + weights[i]!;
  }

  const contentWeight = (start: number, end: number): number => prefix[end]! - prefix[start]!;
  const rangeWeight = (start: number, end: number): number =>
    systemHeaderWeight(start, measures) + contentWeight(start, end);

  const maxAllowed = TARGET_SYSTEM_WEIGHT * MAX_SYSTEM_OVERFLOW_RATIO;

  if (n <= MAX_BARS_PER_SYSTEM && rangeWeight(0, n) <= maxAllowed) {
    return [
      {
        measures: [...measures],
        hasFingerings: measures.some(measureHasFingerings),
      },
    ];
  }

  let minSystems = 0;
  let pos = 0;
  while (pos < n) {
    let end = pos + 1;
    while (
      end < n &&
      end - pos < MAX_BARS_PER_SYSTEM &&
      rangeWeight(pos, end + 1) <= TARGET_SYSTEM_WEIGHT * 1.04
    ) {
      end++;
    }
    pos = end;
    minSystems++;
  }

  const INF = 1e15;

  const solveForSystemCount = (S: number): PartitionSolution | null => {
    if (S < 1 || S > n) return null;

    const avgHeader =
      (systemHeaderWeight(0, measures) +
        Math.max(0, S - 1) * (OTHER_SYSTEM_BASE_HEADER + Math.abs(measures[0]?.keyFifths ?? 0) * KEY_ACCIDENTAL_WEIGHT)) /
      S;
    const idealWeight = Math.min(TARGET_SYSTEM_WEIGHT * 0.94, avgHeader + prefix[n]! / S);

    // dp[s][i][b] = min cost to place first i measures into s systems where the s-th system has b bars
    const dp: number[][][] = Array.from({ length: S + 1 }, () =>
      Array.from({ length: n + 1 }, () => new Array<number>(MAX_BARS_PER_SYSTEM + 1).fill(INF)),
    );
    const prevBarsArr: number[][][] = Array.from({ length: S + 1 }, () =>
      Array.from({ length: n + 1 }, () => new Array<number>(MAX_BARS_PER_SYSTEM + 1).fill(-1)),
    );

    const singleLineCost = (j: number, i: number): number => {
      const w = rangeWeight(j, i);
      const b = i - j;
      let cost = 0;

      if (w > maxAllowed) {
        if (b > 1) return INF;
        const over = w - TARGET_SYSTEM_WEIGHT;
        cost += over * over * 10;
      } else if (w > TARGET_SYSTEM_WEIGHT * 0.96) {
        const excess = w - TARGET_SYSTEM_WEIGHT * 0.96;
        cost += excess * excess * 5;
      }

      const diff = w - idealWeight;
      cost += diff * diff;

      // Strongly avoid single-bar systems unless the bar truly cannot share with either neighbor
      if (b === 1 && n > 1) {
        const canShareLeft = j > 0 && rangeWeight(j - 1, i) <= maxAllowed;
        const canShareRight = i < n && rangeWeight(j, i + 1) <= maxAllowed;
        cost += canShareLeft || canShareRight ? 250000 : 20000;
      }

      // Discourage breaking across a barline tie
      if (i < n && endsWithTie(measures[i - 1]!)) {
        cost += 12000;
      }

      return cost;
    };

    for (let b = 1; b <= Math.min(MAX_BARS_PER_SYSTEM, n); b++) {
      const cost = singleLineCost(0, b);
      if (cost < INF) {
        dp[1]![b]![b] = cost;
        prevBarsArr[1]![b]![b] = 0;
      }
    }

    for (let s = 2; s <= S; s++) {
      const minI = s;
      const maxI = Math.min(n, s * MAX_BARS_PER_SYSTEM);
      for (let i = minI; i <= maxI; i++) {
        for (let b = 1; b <= Math.min(MAX_BARS_PER_SYSTEM, i - (s - 1)); b++) {
          const j = i - b;
          const lineC = singleLineCost(j, i);
          if (lineC >= INF) continue;

          const currW = rangeWeight(j, i);
          const currAvgBarW = contentWeight(j, i) / b;

          let bestVal = INF;
          let bestPb = -1;

          for (let pb = 1; pb <= Math.min(MAX_BARS_PER_SYSTEM, j - (s - 2)); pb++) {
            const base = dp[s - 1]![j]![pb]!;
            if (base >= INF) continue;

            const pj = j - pb;
            const prevW = rangeWeight(pj, j);
            const prevAvgBarW = contentWeight(pj, j) / pb;

            // Penalize abrupt density shifts between adjacent systems
            const weightJump = (currW - prevW) * 0.35;
            let pairCost = weightJump * weightJump;

            // Prefer equal bar counts when adjacent systems have similar per-bar content density
            if (b !== pb) {
              const lo = Math.max(1, Math.min(prevAvgBarW, currAvgBarW));
              const hi = Math.max(prevAvgBarW, currAvgBarW);
              if (hi / lo <= 1.35) {
                pairCost += Math.abs(b - pb) * 2500;
              }
            }

            const total = base + lineC + pairCost;
            if (total < bestVal) {
              bestVal = total;
              bestPb = pb;
            }
          }

          if (bestVal < INF) {
            dp[s]![i]![b] = bestVal;
            prevBarsArr[s]![i]![b] = bestPb;
          }
        }
      }
    }

    let bestFinalCost = INF;
    let bestLastB = -1;
    for (let b = 1; b <= MAX_BARS_PER_SYSTEM; b++) {
      const c = dp[S]![n]![b]!;
      if (c < bestFinalCost) {
        bestFinalCost = c;
        bestLastB = b;
      }
    }
    if (bestLastB === -1) return null;

    const breaks: Array<[number, number]> = [];
    let curI = n;
    let curB = bestLastB;
    for (let s = S; s >= 1; s--) {
      const start = curI - curB;
      breaks.push([start, curI]);
      const pb = prevBarsArr[s]![curI]![curB]!;
      curI = start;
      curB = pb;
    }
    breaks.reverse();

    return { cost: bestFinalCost, breaks };
  };

  // Compare minSystems vs minSystems + 1 (only choosing an extra system when it materially
  // reduces crowding or imbalance, e.g. eliminating a cramped or uneven split).
  const solMin = solveForSystemCount(minSystems);
  const solPlusOne = minSystems + 1 <= n ? solveForSystemCount(minSystems + 1) : null;
  const EXTRA_SYSTEM_PENALTY = 30000;

  let chosen: PartitionSolution | null = solMin;
  if (solPlusOne && (!chosen || solPlusOne.cost + EXTRA_SYSTEM_PENALTY < chosen.cost)) {
    chosen = solPlusOne;
  }

  // Extremely wide fingering labels can exceed the cost ceiling even on their own line.
  if (!chosen) {
    const systems: NotatedSystem[] = [];
    let p = 0;
    while (p < n) {
      let end = p + 1;
      while (
        end < n &&
        end - p < MAX_BARS_PER_SYSTEM &&
        rangeWeight(p, end + 1) <= maxAllowed
      ) {
        end++;
      }
      const slice = measures.slice(p, end);
      systems.push({
        measures: slice,
        hasFingerings: slice.some(measureHasFingerings),
      });
      p = end;
    }
    return systems;
  }

  return chosen.breaks.map(([start, end]) => {
    const slice = measures.slice(start, end);
    return {
      measures: slice,
      hasFingerings: slice.some(measureHasFingerings),
    };
  });
}
