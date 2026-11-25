import { TPQ, type NoteEvent, type TupletSpan } from '../model/types';
import { ImportError } from './errors';

export interface RawModernTuplet {
  n?: unknown;
  startTick?: unknown;
  spanTicks?: unknown;
}

/**
 * Largest power of two strictly below `actual` (e.g. 3 -> 2, 5/6/7 -> 4).
 */
function normalForTuplet(actual: number): number {
  let normal = 1;
  while (normal * 2 < actual) {
    normal *= 2;
  }
  return normal;
}

export function extractModernTuplets(
  rawTuplets: readonly RawModernTuplet[],
  tickOffsetToSubtract: number,
  warnings: string[],
  voicePrefix = '',
): TupletSpan[] {
  const byKey = new Map<string, TupletSpan>();

  for (const raw of rawTuplets) {
    const n = raw.n;
    const rawStart = raw.startTick;
    const rawSpan = raw.spanTicks;

    if (
      typeof n !== 'number' ||
      !Number.isInteger(n) ||
      n < 2 ||
      n > 9 || // the most that ABC notation can express
      typeof rawStart !== 'number' ||
      !Number.isFinite(rawStart) ||
      typeof rawSpan !== 'number' ||
      !Number.isFinite(rawSpan) ||
      rawSpan <= 0
    ) {
      throw new ImportError(
        'unsupported',
        `The clip contains an unsupported tuplet (n=${String(n)}, spanTicks=${String(rawSpan)}).`,
      );
    }

    const startTick = Math.round(rawStart) - tickOffsetToSubtract;
    const spanTicks = Math.round(rawSpan);
    if (startTick < 0 || spanTicks <= 0) {
      throw new ImportError(
        'unsupported',
        `The clip contains an invalid tuplet position (startTick=${String(rawStart)}, spanTicks=${String(rawSpan)}).`,
      );
    }

    const actual = n;
    const normal = normalForTuplet(actual);
    const key = `${startTick}:${spanTicks}:${actual}:${normal}`;
    if (!byKey.has(key)) {
      byKey.set(key, { startTick, spanTicks, actual, normal });
    }
  }

  const sorted = [...byKey.values()].sort((a, b) => a.startTick - b.startTick || a.spanTicks - b.spanTicks);
  const nonOverlapping: TupletSpan[] = [];
  let droppedOverlaps = 0;

  for (const span of sorted) {
    const prev = nonOverlapping[nonOverlapping.length - 1];
    if (prev && span.startTick < prev.startTick + prev.spanTicks) {
      droppedOverlaps += 1;
      continue;
    }
    nonOverlapping.push(span);
  }

  if (droppedOverlaps > 0) {
    warnings.push(
      `${voicePrefix}Ignored ${droppedOverlaps} overlapping tuplet${droppedOverlaps === 1 ? '' : 's'}.`,
    );
  }

  return nonOverlapping;
}

/**
 * In TPQ = 480, every binary note value down to a 128th note (15 ticks) is a multiple of 15.
 * Triplet subdivisions (320, 160, 80, 40 ticks) and quintuplets (96 ticks) never divide by 15.
 */
function isBinaryGridTick(tick: number): boolean {
  return tick % 15 === 0;
}

function allInternalBoundariesMatchUnit(
  sortedBoundaries: readonly number[],
  startTick: number,
  endTick: number,
  unit: number,
): boolean {
  for (const b of sortedBoundaries) {
    if (b <= startTick) continue;
    if (b >= endTick) break;
    if ((b - startTick) % unit !== 0) {
      return false;
    }
  }
  return true;
}

function hasQuarterTripletEvidence(
  events: readonly NoteEvent[],
  offGridBoundaries: readonly number[],
  startTick: number,
  endTick: number,
): boolean {
  const mid = startTick + TPQ; // startTick + 480
  // Evidence 1: off-grid boundaries exist at both third-points (start + 320 and start + 640).
  const hasFirstThird = offGridBoundaries.includes(startTick + 320);
  const hasSecondThird = offGridBoundaries.includes(startTick + 640);
  if (hasFirstThird && hasSecondThird) {
    return true;
  }
  // Evidence 2: an event crosses the beat midpoint (start + 480) and starts or ends on an
  // off-grid third-point inside the span.
  for (const ev of events) {
    const evStart = ev.tick;
    const evEnd = ev.tick + ev.durationTicks;
    if (evStart < mid && evEnd > mid) {
      const startOffGridInSpan = evStart > startTick && evStart < endTick && !isBinaryGridTick(evStart);
      const endOffGridInSpan = evEnd > startTick && evEnd < endTick && !isBinaryGridTick(evEnd);
      if (startOffGridInSpan || endOffGridInSpan) {
        return true;
      }
    }
  }
  return false;
}

function overlapsExisting(spans: readonly TupletSpan[], startTick: number, spanTicks: number): boolean {
  const endTick = startTick + spanTicks;
  for (const s of spans) {
    if (startTick < s.startTick + s.spanTicks && endTick > s.startTick) {
      return true;
    }
  }
  return false;
}

/**
 * Infers `TupletSpan[]` from event timing when importing legacy Hookpad clips (which have no
 * explicit tuplet tags).
 *
 * Supports:
 * - Quarter-note triplets (`spanTicks = 960`, `actual = 3`, `normal = 2`, unit 320) aligned to any beat
 * - Eighth-note triplets (`spanTicks = 480`, `actual = 3`, `normal = 2`, unit 160) aligned to beats
 * - Sixteenth-note triplets (`spanTicks = 240`, `actual = 3`, `normal = 2`, unit 80) aligned to half-beats
 * - Thirty-second-note triplets (`spanTicks = 120`, `actual = 3`, `normal = 2`, unit 40) aligned to quarter-beats
 * - Quintuplets (`spanTicks = 480`, `actual = 5`, `normal = 4`, unit 96) aligned to beats
 *
 * Also handles spans that contain only one note onset because an earlier long note extends into
 * the triplet span (such as tick 4800..5280 in the reference clip).
 */
export function inferLegacyTuplets(events: readonly NoteEvent[]): TupletSpan[] {
  const boundarySet = new Set<number>();
  for (const ev of events) {
    boundarySet.add(ev.tick);
    boundarySet.add(ev.tick + ev.durationTicks);
  }
  const sortedBoundaries = [...boundarySet].sort((a, b) => a - b);
  const offGridBoundaries = sortedBoundaries.filter((b) => !isBinaryGridTick(b));

  if (offGridBoundaries.length === 0) {
    return [];
  }

  const spans: TupletSpan[] = [];
  const isCovered = (tick: number): boolean =>
    spans.some((s) => tick > s.startTick && tick < s.startTick + s.spanTicks);

  // Pass 1: Quarter-note triplets (span 960, unit 320, beat-aligned startTick % 480 === 0).
  // For any off-grid multiple of 160, there is at most one beat-aligned 960-tick span whose
  // third-points (start + 320 or start + 640) include that tick.
  for (const t of offGridBoundaries) {
    if (isCovered(t) || t % 160 !== 0) continue;
    const modBeat = t % TPQ;
    let candidateStart = -1;
    if (modBeat === 320) {
      candidateStart = t - 320;
    } else if (modBeat === 160) {
      candidateStart = t - 640;
    }
    if (candidateStart < 0 || candidateStart % TPQ !== 0) continue;

    const spanTicks = TPQ * 2; // 960
    const endTick = candidateStart + spanTicks;
    if (
      !overlapsExisting(spans, candidateStart, spanTicks) &&
      allInternalBoundariesMatchUnit(sortedBoundaries, candidateStart, endTick, 320) &&
      hasQuarterTripletEvidence(events, offGridBoundaries, candidateStart, endTick)
    ) {
      spans.push({ startTick: candidateStart, spanTicks, actual: 3, normal: 2 });
    }
  }

  const patterns = [
    { spanTicks: TPQ, actual: 3, normal: 2 },
    { spanTicks: TPQ / 2, actual: 3, normal: 2 },
    { spanTicks: TPQ / 4, actual: 3, normal: 2 },
    { spanTicks: TPQ, actual: 5, normal: 4 },
  ];
  for (const { spanTicks, actual, normal } of patterns) {
    const unit = spanTicks / actual;
    for (const tick of offGridBoundaries) {
      if (isCovered(tick) || tick % unit !== 0) continue;
      const startTick = Math.floor(tick / spanTicks) * spanTicks;
      if (
        !overlapsExisting(spans, startTick, spanTicks) &&
        allInternalBoundariesMatchUnit(sortedBoundaries, startTick, startTick + spanTicks, unit)
      ) {
        spans.push({ startTick, spanTicks, actual, normal });
      }
    }
  }

  spans.sort((a, b) => a.startTick - b.startTick);
  return spans;
}
