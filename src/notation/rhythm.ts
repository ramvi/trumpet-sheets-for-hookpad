import { createMeasureCursor, type MeasureSpan } from '../model/measure';
import {
  TPQ,
  type Melody,
  type MeterChange,
  type Pitch,
  type TupletSpan,
} from '../model/types';
import type { NotatedElement, NotatedMeasure, ScoreStats } from './types';

/**
 * Standard plain and dotted durations in ticks (TPQ = 480).
 * Sorted descending for greedy fallback splitting.
 */
const STANDARD_NOTE_DURATIONS: readonly number[] = [
  1920, // whole
  1440, // dotted half
  960,  // half
  720,  // dotted quarter
  480,  // quarter
  360,  // dotted eighth
  240,  // eighth
  180,  // dotted 16th
  120,  // 16th
  90,   // dotted 32nd
  60,   // 32nd
  30,   // 64th
];

const STANDARD_NOTE_SET = new Set<number>(STANDARD_NOTE_DURATIONS);

const PLAIN_REST_DURATIONS: readonly number[] = [
  1920, // whole
  960,  // half
  480,  // quarter
  240,  // eighth
  120,  // 16th
  60,   // 32nd
  30,   // 64th
];

const DOTTED_QUARTER = 720;

function getBeatTicks(meter: MeterChange): number {
  const isCompound = meter.denominator === 8 && meter.numerator % 3 === 0;
  return isCompound ? DOTTED_QUARTER : Math.round((TPQ * 4) / meter.denominator);
}

function isStandardNoteDuration(ticks: number): boolean {
  return STANDARD_NOTE_SET.has(ticks);
}

function largestStandardNoteDuration(maxTicks: number): number {
  for (const d of STANDARD_NOTE_DURATIONS) {
    if (d <= maxTicks) return d;
  }
  return maxTicks;
}

function largestStandardMultipleOfBeat(maxTicks: number, beatTicks: number): number {
  for (const d of STANDARD_NOTE_DURATIONS) {
    if (d <= maxTicks && d % beatTicks === 0) return d;
  }
  return 0;
}

/**
 * Splits a note duration inside a measure (outside tuplets) into standard plain/dotted values:
 * - When `midBarTick` is provided (4/4 bar midpoint = beat 3), any note crossing it is split
 *   and tied at `midBarTick` unless it both starts on a quarter-beat and ends on a quarter-beat
 *   (so a half note on beat 2, a dotted half, and a whole note stay single values).
 * - A note starting on a beat stays a single plain or dotted value when one exists and fits.
 * - A note staying within a single beat stays a single plain or dotted value when one exists.
 * - Otherwise split at beat boundaries with ties.
 */
function splitNoteDuration(
  off: number,
  dur: number,
  beatTicks: number,
  midBarTick?: number,
): number[] {
  if (dur <= 0) return [];

  if (
    midBarTick !== undefined &&
    off < midBarTick &&
    off + dur > midBarTick &&
    (off % beatTicks !== 0 || (off + dur) % beatTicks !== 0)
  ) {
    const firstPart = midBarTick - off;
    return [
      ...splitNoteDuration(off, firstPart, beatTicks),
      ...splitNoteDuration(midBarTick, dur - firstPart, beatTicks),
    ];
  }

  const onBeat = off % beatTicks === 0;
  const nextBeat = (Math.floor(off / beatTicks) + 1) * beatTicks;

  const crossesCompoundBeat =
    beatTicks === DOTTED_QUARTER && dur > beatTicks && dur % beatTicks !== 0;
  if (onBeat && isStandardNoteDuration(dur) && !crossesCompoundBeat) {
    return [dur];
  }
  if (off + dur <= nextBeat && isStandardNoteDuration(dur)) {
    return [dur];
  }

  if (onBeat) {
    const fullBeats = Math.floor(dur / beatTicks);
    if (fullBeats >= 1) {
      const wholeBeatDur = largestStandardMultipleOfBeat(fullBeats * beatTicks, beatTicks);
      if (wholeBeatDur > 0 && wholeBeatDur < dur) {
        return [wholeBeatDur, ...splitNoteDuration(off + wholeBeatDur, dur - wholeBeatDur, beatTicks)];
      }
    }
    const largest = largestStandardNoteDuration(dur);
    if (largest > 0 && largest < dur) {
      return [largest, ...splitNoteDuration(off + largest, dur - largest, beatTicks)];
    }
    return [dur];
  }

  if (off + dur > nextBeat) {
    const firstPart = nextBeat - off;
    return [
      ...splitNoteDuration(off, firstPart, beatTicks),
      ...splitNoteDuration(nextBeat, dur - firstPart, beatTicks),
    ];
  }

  const largest = largestStandardNoteDuration(dur);
  if (largest > 0 && largest < dur) {
    return [largest, ...splitNoteDuration(off + largest, dur - largest, beatTicks)];
  }
  return [dur];
}

function splitRestDuration(
  off: number,
  dur: number,
  measureTicks: number,
  beatTicks: number,
): number[] {
  if (dur <= 0) return [];

  if (off === 0 && dur === measureTicks && PLAIN_REST_DURATIONS.includes(dur)) {
    return [dur];
  }

  const nextBeat = (Math.floor(off / beatTicks) + 1) * beatTicks;

  if (off % beatTicks !== 0) {
    const toNextBeat = Math.min(dur, nextBeat - off);
    const subParts = decomposePlainRestSubBeat(off, toNextBeat);
    if (toNextBeat < dur) {
      return [...subParts, ...splitRestDuration(off + toNextBeat, dur - toNextBeat, measureTicks, beatTicks)];
    }
    return subParts;
  }

  if (beatTicks === DOTTED_QUARTER && dur >= beatTicks) {
    return [beatTicks, ...splitRestDuration(off + beatTicks, dur - beatTicks, measureTicks, beatTicks)];
  }

  // On a beat: check strong-beat two-beat rest (e.g. half rest on beat 1 or beat 3 in 4/4)
  const twoBeats = beatTicks * 2;
  if (
    dur >= twoBeats &&
    off % twoBeats === 0 &&
    PLAIN_REST_DURATIONS.includes(twoBeats)
  ) {
    return [twoBeats, ...splitRestDuration(off + twoBeats, dur - twoBeats, measureTicks, beatTicks)];
  }

  if (dur >= beatTicks && PLAIN_REST_DURATIONS.includes(beatTicks)) {
    return [beatTicks, ...splitRestDuration(off + beatTicks, dur - beatTicks, measureTicks, beatTicks)];
  }

  for (const d of PLAIN_REST_DURATIONS) {
    if (d <= dur) {
      return [d, ...splitRestDuration(off + d, dur - d, measureTicks, beatTicks)];
    }
  }
  return [dur];
}

function decomposePlainRestSubBeat(off: number, dur: number): number[] {
  if (dur <= 0) return [];
  for (const d of PLAIN_REST_DURATIONS) {
    if (d === dur) return [d];
  }
  // Align up to a coarser grid boundary first (e.g. offset 120 + dur 360 -> 120 + 240)
  for (let i = PLAIN_REST_DURATIONS.length - 1; i >= 0; i--) {
    const d = PLAIN_REST_DURATIONS[i]!;
    if (d < dur && off % (d * 2) === d) {
      return [d, ...decomposePlainRestSubBeat(off + d, dur - d)];
    }
  }
  for (const d of PLAIN_REST_DURATIONS) {
    if (d < dur) {
      return [d, ...decomposePlainRestSubBeat(off + d, dur - d)];
    }
  }
  return [dur];
}

function splitWrittenTupletDuration(writtenTicks: number, isRest: boolean): number[] {
  const rounded = Math.round(writtenTicks);
  if (rounded <= 0) return [];
  const table = isRest ? PLAIN_REST_DURATIONS : STANDARD_NOTE_DURATIONS;
  // Hookpad rounds tuplet notes to whole ticks, so septuplets and the like land slightly off.
  const standard = table.find((d) => Math.abs(d - writtenTicks) <= 3);
  if (standard !== undefined) return [standard];

  const parts: number[] = [];
  let rem = rounded;
  while (rem > 0) {
    let picked = 0;
    for (const d of table) {
      if (d <= rem) {
        picked = d;
        break;
      }
    }
    if (picked === 0) {
      parts.push(rem);
      break;
    }
    parts.push(picked);
    rem -= picked;
  }
  return parts;
}

interface TimelineSegment {
  startTick: number;
  endTick: number;
  pitch: Pitch | null;
  onsetIndex: number; // -1 for rests
  eventStartTick: number;
  eventEndTick: number;
}

interface MeasureScaffold extends MeasureSpan {
  hasMeterChange: boolean;
  hasKeyChange: boolean;
}

function buildMeasureScaffolds(melody: Melody): MeasureScaffold[] {
  const keys = [...melody.keys].sort((a, b) => a.tick - b.tick);
  const meters = [...melody.meters].sort((a, b) => a.tick - b.tick);
  const measureAt = createMeasureCursor(keys, meters);

  let targetEnd = melody.endTick;
  for (const ev of melody.events) {
    targetEnd = Math.max(targetEnd, ev.tick + ev.durationTicks);
  }
  for (const tup of melody.tuplets) {
    targetEnd = Math.max(targetEnd, tup.startTick + tup.spanTicks);
  }

  const scaffolds: MeasureScaffold[] = [];
  let t = 0;
  let prevMeter: MeterChange | null = null;
  let prevKeyFifths: number | null = null;

  do {
    const measure = measureAt(t);
    const { meter, keyFifths, endTick } = measure;

    const hasMeterChange =
      prevMeter !== null &&
      (meter.numerator !== prevMeter.numerator || meter.denominator !== prevMeter.denominator);
    const hasKeyChange = prevKeyFifths !== null && keyFifths !== prevKeyFifths;

    scaffolds.push({ ...measure, hasMeterChange, hasKeyChange });

    prevMeter = meter;
    prevKeyFifths = keyFifths;
    t = endTick;
  } while (t < targetEnd);

  return scaffolds;
}

function buildContiguousTimeline(melody: Melody, totalEndTick: number): {
  segments: TimelineSegment[];
  onsetCount: number;
} {
  const sortedEvents = [...melody.events].sort((a, b) => a.tick - b.tick);
  const segments: TimelineSegment[] = [];
  let cursor = 0;
  let onsetCount = 0;

  for (const ev of sortedEvents) {
    if (ev.durationTicks <= 0) continue;
    const start = Math.max(ev.tick, cursor);
    const end = ev.tick + ev.durationTicks;
    if (end <= start) continue;

    if (start > cursor) {
      segments.push({
        startTick: cursor,
        endTick: start,
        pitch: null,
        onsetIndex: -1,
        eventStartTick: cursor,
        eventEndTick: start,
      });
    }

    if (ev.pitch !== null) {
      const onsetIndex = onsetCount++;
      segments.push({
        startTick: start,
        endTick: end,
        pitch: ev.pitch,
        onsetIndex,
        eventStartTick: start,
        eventEndTick: end,
      });
    } else {
      segments.push({
        startTick: start,
        endTick: end,
        pitch: null,
        onsetIndex: -1,
        eventStartTick: start,
        eventEndTick: end,
      });
    }
    cursor = end;
  }

  if (cursor < totalEndTick) {
    segments.push({
      startTick: cursor,
      endTick: totalEndTick,
      pitch: null,
      onsetIndex: -1,
      eventStartTick: cursor,
      eventEndTick: totalEndTick,
    });
  }

  return { segments, onsetCount };
}

interface RawSlice {
  startTick: number;
  endTick: number;
  pitch: Pitch | null;
  onsetIndex: number;
  eventStartTick: number;
  eventEndTick: number;
  tuplet: TupletSpan | null;
  tupletIndex: number; // -1 if outside tuplet
}

interface RhythmBuildResult {
  measures: NotatedMeasure[];
  stats: Omit<ScoreStats, 'fingeringLabels'>;
}

export function buildMeasuresWithRhythm(
  melody: Melody,
  fingeringLabel?: (pitch: Pitch) => string | null,
): RhythmBuildResult {
  const scaffolds = buildMeasureScaffolds(melody);
  const totalEndTick = scaffolds[scaffolds.length - 1]!.endTick;
  const { segments, onsetCount } = buildContiguousTimeline(melody, totalEndTick);
  const sortedTuplets = [...melody.tuplets].sort((a, b) => a.startTick - b.startTick);

  const measures: NotatedMeasure[] = [];
  let nextTupletGroupId = 0;

  let noteheadCount = 0;
  let tieCount = 0;

  for (const scaffold of scaffolds) {
    const mStart = scaffold.startTick;
    const mEnd = scaffold.endTick;
    const measureTicks = mEnd - mStart;
    const beatTicks = getBeatTicks(scaffold.meter);
    const midBarTick =
      scaffold.meter.numerator === 4 &&
      scaffold.meter.denominator === 4 &&
      measureTicks === TPQ * 4
        ? TPQ * 2
        : undefined;

    const measureTuplets = sortedTuplets
      .map((span, idx) => ({ span, idx }))
      .filter(({ span }) => span.startTick < mEnd && span.startTick + span.spanTicks > mStart);

    const cutPointsSet = new Set<number>([mStart, mEnd]);
    for (const { span } of measureTuplets) {
      const ts = Math.max(mStart, span.startTick);
      const te = Math.min(mEnd, span.startTick + span.spanTicks);
      cutPointsSet.add(ts);
      cutPointsSet.add(te);
    }
    const cutPoints = [...cutPointsSet].sort((a, b) => a - b);

    const rawSlices: RawSlice[] = [];
    for (const seg of segments) {
      if (seg.endTick <= mStart || seg.startTick >= mEnd) continue;
      const segStart = Math.max(seg.startTick, mStart);
      const segEnd = Math.min(seg.endTick, mEnd);

      const innerCuts = [segStart];
      for (const cp of cutPoints) {
        if (cp > segStart && cp < segEnd) innerCuts.push(cp);
      }
      innerCuts.push(segEnd);

      for (let i = 0; i < innerCuts.length - 1; i++) {
        const s = innerCuts[i]!;
        const e = innerCuts[i + 1]!;
        const mid = (s + e) / 2;
        const tupMatch = measureTuplets.find(
          ({ span }) => mid >= span.startTick && mid <= span.startTick + span.spanTicks,
        );
        rawSlices.push({
          startTick: s,
          endTick: e,
          pitch: seg.pitch,
          onsetIndex: seg.onsetIndex,
          eventStartTick: seg.eventStartTick,
          eventEndTick: seg.eventEndTick,
          tuplet: tupMatch ? tupMatch.span : null,
          tupletIndex: tupMatch ? tupMatch.idx : -1,
        });
      }
    }

    const elements: NotatedElement[] = [];
    let sliceIdx = 0;
    while (sliceIdx < rawSlices.length) {
      const first = rawSlices[sliceIdx]!;
      const span = first.tuplet;
      const groupId = span ? nextTupletGroupId++ : -1;
      const groupStart = elements.length;

      do {
        const slice = rawSlices[sliceIdx++]!;
        const offset = slice.startTick - mStart;
        const duration = slice.endTick - slice.startTick;
        const writtenParts = span
          ? splitWrittenTupletDuration((duration * span.actual) / span.normal, slice.pitch === null)
          : slice.pitch === null
            ? splitRestDuration(offset, duration, measureTicks, beatTicks)
            : splitNoteDuration(offset, duration, beatTicks, midBarTick);

        let partStart = slice.startTick;
        for (const [index, writtenTicks] of writtenParts.entries()) {
          const lastPart = index === writtenParts.length - 1;
          const partEnd = span
            ? lastPart ? slice.endTick : partStart + (writtenTicks * span.normal) / span.actual
            : partStart + writtenTicks;
          const shared = {
            startTick: partStart,
            soundingTicks: span ? partEnd - partStart : writtenTicks,
            writtenTicks,
            tuplet: span
              ? { groupId, actual: span.actual, normal: span.normal, itemCount: 0, isStart: false, isEnd: false }
              : null,
          };

          if (slice.pitch === null) {
            elements.push({ kind: 'rest', ...shared });
          } else {
            const isOnset = index === 0 && slice.startTick === slice.eventStartTick;
            const tiedToNext = !lastPart || slice.endTick < slice.eventEndTick;
            const label = isOnset && fingeringLabel ? fingeringLabel(slice.pitch) : null;
            noteheadCount++;
            if (tiedToNext) tieCount++;

            elements.push({
              kind: 'note',
              ...shared,
              pitch: slice.pitch,
              isOnset,
              onsetIndex: slice.onsetIndex,
              tiedFromPrev: !isOnset,
              tiedToNext,
              printedAccidental: null,
              fingering: label,
              beamGroup: Math.floor((partStart - mStart) / beatTicks),
            });
          }
          partStart = partEnd;
        }
      } while (span && rawSlices[sliceIdx]?.tupletIndex === first.tupletIndex);

      if (span) {
        for (let index = groupStart; index < elements.length; index++) {
          const tuplet = elements[index]!.tuplet!;
          tuplet.itemCount = elements.length - groupStart;
          tuplet.isStart = index === groupStart;
          tuplet.isEnd = index === elements.length - 1;
        }
      }
    }

    measures.push({
      meter: scaffold.meter,
      hasMeterChange: scaffold.hasMeterChange,
      keyFifths: scaffold.keyFifths,
      hasKeyChange: scaffold.hasKeyChange,
      elements,
    });
  }

  return {
    measures,
    stats: {
      measures: measures.length,
      onsets: onsetCount,
      noteheads: noteheadCount,
      tupletGroups: nextTupletGroupId,
      ties: tieCount,
    },
  };
}
