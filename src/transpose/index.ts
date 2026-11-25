import {
  TPQ,
  type KeyChange,
  type Melody,
  type Mode,
  type Pitch,
  type PitchClass,
} from '../model/types';
import {
  STEP_ORDER,
  diatonicStepsBetween,
  keySignatureFifths,
  pitchClassSemitone,
  pitchToMidi,
  simplifySpelling,
  transposePitch,
  transposePitchClass,
} from '../model/pitch';
import { AccidentalTracker } from '../model/accidentals';
import { createMeasureCursor, type MeasureSpan } from '../model/measure';
import { isDemandingFingering } from '../fingering';

export type InputPitch = 'concert' | 'written';

/** All values are MIDI numbers of WRITTEN trumpet pitch. */
export interface RegisterProfile {
  center: number;
  preferredLow: number;
  preferredHigh: number;
  comfortLow: number;
  comfortHigh: number;
  limitLow: number;
  limitHigh: number;
}

export const DEFAULT_PROFILE: RegisterProfile = {
  center: 67,
  preferredLow: 62,
  preferredHigh: 70,
  comfortLow: 60,
  comfortHigh: 72,
  limitLow: 55,
  limitHigh: 75,
};

/**
 * Tunable weights for `Candidate.combinedScore`:
 *   combinedScore = score / W
 *                 + RANKING_WEIGHTS.demandingFingering * (Wd / W)
 *                 + RANKING_WEIGHTS.keyAccidentals * keyAccidentals
 *
 * - `demandingFingering`: penalty for the attack-weight fraction using third-valve
 *   combinations (2+3, 1+3, 1+2+3).
 * - `keyAccidentals`: penalty per sharp/flat (|fifths|) in the active key signature
 *   (attack-weight-weighted average over key regions when a melody modulates).
 */
export const RANKING_WEIGHTS = {
  demandingFingering: 0.5,
  keyAccidentals: 0.12,
} as const;

export interface OutOfRangeNote {
  pitch: Pitch;
  semitonesOutside: number;
  side: 'low' | 'high';
}

export interface Candidate {
  semitones: number; // shift applied to the written base (0 = unchanged)
  melody: Melody; // the written part after the shift, re-spelled in the new key
  writtenKey: KeyChange; // first key of `melody`
  hookpadKey: { tonic: PitchClass; mode: Mode }; // concert key for the accompaniment = written key a major second down
  lowest: Pitch;
  highest: Pitch;
  fits: boolean; // every note inside limitLow..limitHigh
  outOfRange: OutOfRangeNote[];
  overflowTotal: number;
  score: number;
  combinedScore: number;
  tiebreak: {
    centerDistance: number;
    hardFingerings: number;
    accidentals: number;
    absShift: number;
  };
}

export interface Ranking {
  best: Candidate;
  candidates: Candidate[]; // sorted best-first
  anyFits: boolean;
}

function mod12(n: number): number {
  return ((n % 12) + 12) % 12;
}

/**
 * Picks the conventional tonic spelling for a target pitch class (0..11) and mode.
 *
 * Rule: among all single-accidental or natural spellings (|alter| <= 1) of `targetPc`,
 * choose the one whose key signature has the fewest accidentals (smallest |fifths|).
 * On a tie (such as 6♯ vs 6♭: F♯/G♭ major, D♯/E♭ minor, G♯/A♭ dorian, C♯/D♭ mixolydian,
 * A♯/B♭ phrygian): prefer a natural tonic if one exists (e.g. B lydian over C♭ lydian,
 * F locrian over E♯ locrian), otherwise prefer flats (fifths < 0, e.g. G♭ major, E♭ minor).
 */
function conventionalTonicFor(targetPc: number, mode: Mode): PitchClass {
  const pc = mod12(targetPc);
  const options: PitchClass[] = [];
  for (const step of STEP_ORDER) {
    for (const alter of [-1, 0, 1]) {
      if (pitchClassSemitone({ step, alter }) === pc) {
        options.push({ step, alter });
      }
    }
  }

  options.sort((a, b) => {
    const fa = keySignatureFifths(a, mode);
    const fb = keySignatureFifths(b, mode);
    const absDiff = Math.abs(fa) - Math.abs(fb);
    if (absDiff !== 0) return absDiff;

    const alterDiff = Math.abs(a.alter) - Math.abs(b.alter);
    if (alterDiff !== 0) return alterDiff;

    return fa - fb;
  });

  return options[0]!;
}

export function toWrittenBase(melody: Melody, input: InputPitch): Melody {
  if (input === 'written') {
    return melody;
  }
  return {
    ...melody,
    keys: melody.keys.map((key) => ({ ...key, tonic: transposePitchClass(key.tonic, 1, 2) })),
    events: melody.events.map((event) => ({ ...event, pitch: event.pitch && transposePitch(event.pitch, 1, 2) })),
  };
}

/** Every key region gets its own conventional spelling, so each one has a printable key signature. */
export function transposeMelody(melody: Melody, semitones: number): Melody {
  const regions = melody.keys.map((key) => {
    const target = mod12(pitchClassSemitone(key.tonic) + semitones);
    const tonic = conventionalTonicFor(target, key.mode);
    return { key: { ...key, tonic }, steps: diatonicStepsBetween(key.tonic, tonic, semitones) };
  });
  return {
    ...melody,
    keys: regions.map(({ key }) => key),
    events: melody.events.map((event) => {
      const { steps } = regions.findLast(({ key }) => key.tick <= event.tick)!;
      return { ...event, pitch: event.pitch && simplifySpelling(transposePitch(event.pitch, steps, semitones)) };
    }),
  };
}

/**
 * Returns the concert key Hookpad's accompaniment must be in for a given written B♭-trumpet key:
 * a major second down, conventionally spelled.
 */
export function concertKeyFor(writtenKey: { tonic: PitchClass; mode: Mode }): {
  tonic: PitchClass;
  mode: Mode;
} {
  const targetPc = mod12(pitchClassSemitone(writtenKey.tonic) - 2);
  return {
    tonic: conventionalTonicFor(targetPc, writtenKey.mode),
    mode: writtenKey.mode,
  };
}

function distanceToRange(value: number, low: number, high: number): number {
  if (value < low) return low - value;
  if (value > high) return value - high;
  return 0;
}

function countAccidentals(melody: Melody): number {
  const keySigAccidentals = melody.keys.reduce(
    (sum, k) => sum + Math.abs(keySignatureFifths(k.tonic, k.mode)),
    0,
  );

  const measureAt = createMeasureCursor(melody.keys, melody.meters);
  const tracker = new AccidentalTracker();
  let previousMeasure: MeasureSpan | undefined;
  let localAccidentals = 0;

  for (const event of melody.events) {
    if (event.pitch === null) continue;

    const measure = measureAt(event.tick);
    if (measure !== previousMeasure) {
      tracker.startMeasure(measure.keyFifths, previousMeasure?.endTick === measure.startTick);
      previousMeasure = measure;
    }
    if (tracker.shouldPrint(event.pitch)) localAccidentals++;
  }

  return keySigAccidentals + localAccidentals;
}

interface EvaluatedCandidate {
  candidate: Candidate;
  /** Exact numerator of `score` in ticks (score = scoreTicks / TPQ), avoiding float comparison noise. */
  scoreTicks: number;
  /** Exact numerator of `tiebreak.centerDistance` in ticks, avoiding float comparison noise. */
  centerDistanceTicks: number;
}

function evaluateCandidate(
  writtenBase: Melody,
  semitones: number,
  profile: RegisterProfile,
): EvaluatedCandidate {
  const melody = transposeMelody(writtenBase, semitones);
  const writtenKey: KeyChange = melody.keys[0] ?? {
    tick: 0,
    tonic: { step: 'C', alter: 0 },
    mode: 'major',
  };
  const hookpadKey = concertKeyFor({ tonic: writtenKey.tonic, mode: writtenKey.mode });

  let lowest: Pitch | null = null;
  let highest: Pitch | null = null;
  let lowestMidi = Infinity;
  let highestMidi = -Infinity;

  const outOfRange: OutOfRangeNote[] = [];
  let overflowTotal = 0;
  let scoreTicks = 0;
  let centerDistanceTicks = 0;
  let totalWeightTicks = 0;
  let demandingWeightTicks = 0;
  let keyAccWeightTicks = 0;
  let hardFingerings = 0;

  const keys = melody.keys;
  let keyIdx = 0;

  for (let i = 0; i < melody.events.length; i++) {
    const ev = melody.events[i]!;
    if (ev.pitch === null) continue;

    while (keyIdx + 1 < keys.length && keys[keyIdx + 1]!.tick <= ev.tick) {
      keyIdx++;
    }
    const activeKey = keys[keyIdx] ?? writtenKey;
    const activeKeyFifths = Math.abs(keySignatureFifths(activeKey.tonic, activeKey.mode));

    const midi = pitchToMidi(ev.pitch);
    if (midi < lowestMidi) {
      lowestMidi = midi;
      lowest = ev.pitch;
    }
    if (midi > highestMidi) {
      highestMidi = midi;
      highest = ev.pitch;
    }

    if (midi < profile.limitLow) {
      const semitonesOutside = profile.limitLow - midi;
      outOfRange.push({
        pitch: ev.pitch,
        semitonesOutside,
        side: 'low',
      });
      overflowTotal += semitonesOutside;
    } else if (midi > profile.limitHigh) {
      const semitonesOutside = midi - profile.limitHigh;
      outOfRange.push({
        pitch: ev.pitch,
        semitonesOutside,
        side: 'high',
      });
      overflowTotal += semitonesOutside;
    }

    // Weigh by beats, so the time signature does not change which key is best.
    const weightTicks = TPQ + (ev.durationTicks * melody.meters[0]!.denominator) / 4;
    const distPreferred = distanceToRange(midi, profile.preferredLow, profile.preferredHigh);
    const distComfort = distanceToRange(midi, profile.comfortLow, profile.comfortHigh);
    totalWeightTicks += weightTicks;
    scoreTicks += weightTicks * (distPreferred + 2 * distComfort);
    centerDistanceTicks += weightTicks * Math.abs(midi - profile.center);
    keyAccWeightTicks += weightTicks * activeKeyFifths;

    if (isDemandingFingering(ev.pitch)) {
      hardFingerings++;
      demandingWeightTicks += weightTicks;
    }
  }

  const combinedScore =
    totalWeightTicks === 0
      ? 0
      : scoreTicks / totalWeightTicks +
        RANKING_WEIGHTS.demandingFingering * (demandingWeightTicks / totalWeightTicks) +
        RANKING_WEIGHTS.keyAccidentals * (keyAccWeightTicks / totalWeightTicks);

  const fallbackPitch: Pitch = { step: writtenKey.tonic.step, alter: writtenKey.tonic.alter, octave: 4 };
  const accidentals = countAccidentals(melody);

  const candidate: Candidate = {
    semitones,
    melody,
    writtenKey,
    hookpadKey,
    lowest: lowest ?? fallbackPitch,
    highest: highest ?? fallbackPitch,
    fits: outOfRange.length === 0,
    outOfRange,
    overflowTotal,
    score: scoreTicks / TPQ,
    combinedScore,
    tiebreak: {
      centerDistance: centerDistanceTicks / TPQ,
      hardFingerings,
      accidentals,
      absShift: Math.abs(semitones),
    },
  };

  return { candidate, scoreTicks, centerDistanceTicks };
}

const FLOAT_EPS = 1e-9;

// Each candidate stores a full melody, so a malformed octave offset can exhaust memory.
const MAX_CANDIDATES = 256;

function compareNumbers(a: number, b: number): number {
  const diff = a - b;
  return Math.abs(diff) <= FLOAT_EPS ? 0 : diff;
}

/**
 * Candidate ranking comparator (best-first):
 * 1. Fitting candidates (every attack within limitLow..limitHigh) come before non-fitting ones.
 *    Among non-fitting candidates, smaller `overflowTotal` (sum of semitones outside limits) wins.
 * 2. Lower `combinedScore` (compared with `FLOAT_EPS` to avoid floating-point noise):
 *    `score / W + RANKING_WEIGHTS.demandingFingering * (Wd / W) + RANKING_WEIGHTS.keyAccidentals * keyAccidentals`,
 *    where `W` is the sum of attack weights `(1 + durationInQuarters)`, `Wd` is the same sum over
 *    demanding third-valve fingerings, and `keyAccidentals` is the attack-weight-weighted average |fifths|.
 * 3. Lower `score` (compared via exact `scoreTicks`):
 *    sum over attacks of `(1 + durationInQuarters) * (distToPreferred + 2 * distOutsideComfort)`.
 * 4. Lower `tiebreak.centerDistance` (via exact `centerDistanceTicks`):
 *    sum over attacks of `(1 + durationInQuarters) * |midi - profile.center|`.
 * 5. Fewer `tiebreak.hardFingerings` (attacks requiring third-valve combinations 2+3, 1+3, 1+2+3).
 * 6. Fewer `tiebreak.accidentals` (key-signature |fifths| across all keys + printed local accidentals).
 * 7. Smaller `tiebreak.absShift` (|semitones|, least extra transposition).
 * 8. Lower placement (smaller `semitones`).
 */
function compareEvaluated(a: EvaluatedCandidate, b: EvaluatedCandidate): number {
  const ca = a.candidate;
  const cb = b.candidate;

  if (ca.fits !== cb.fits) return ca.fits ? -1 : 1;
  if (!ca.fits) {
    const overflowDiff = ca.overflowTotal - cb.overflowTotal;
    if (overflowDiff !== 0) return overflowDiff;
  }

  const combinedDiff = compareNumbers(ca.combinedScore, cb.combinedScore);
  if (combinedDiff !== 0) return combinedDiff;

  const scoreDiff = compareNumbers(a.scoreTicks, b.scoreTicks);
  if (scoreDiff !== 0) return scoreDiff;

  const centerDiff = compareNumbers(a.centerDistanceTicks, b.centerDistanceTicks);
  if (centerDiff !== 0) return centerDiff;

  const fingeringDiff = ca.tiebreak.hardFingerings - cb.tiebreak.hardFingerings;
  if (fingeringDiff !== 0) return fingeringDiff;

  const accidentalDiff = ca.tiebreak.accidentals - cb.tiebreak.accidentals;
  if (accidentalDiff !== 0) return accidentalDiff;

  const absShiftDiff = ca.tiebreak.absShift - cb.tiebreak.absShift;
  if (absShiftDiff !== 0) return absShiftDiff;

  return ca.semitones - cb.semitones;
}

/**
 * Evaluates and ranks candidate transpositions of a written B♭-trumpet base melody
 * against `profile` (default: `DEFAULT_PROFILE`).
 *
 * Shift window covers every shift where the melody fits inside `limitLow..limitHigh`,
 * every compromise shift between anchoring the low and high extremes when the melody is
 * wider than the limits, and at least a full 12-key window (±6 semitones around center).
 */
export function rankCandidates(
  writtenBase: Melody,
  profile: RegisterProfile = DEFAULT_PROFILE,
): Ranking {
  let baseLow = Infinity;
  let baseHigh = -Infinity;

  for (const ev of writtenBase.events) {
    if (ev.pitch === null) continue;
    const midi = pitchToMidi(ev.pitch);
    if (!Number.isSafeInteger(midi)) {
      throw new RangeError('A note has an octave offset too large to transpose.');
    }
    if (midi < baseLow) baseLow = midi;
    if (midi > baseHigh) baseHigh = midi;
  }

  let minShift: number;
  let maxShift: number;

  if (!Number.isFinite(baseLow)) {
    minShift = -6;
    maxShift = 6;
  } else {
    const fitMin = profile.limitLow - baseLow;
    const fitMax = profile.limitHigh - baseHigh;
    const spanLo = Math.min(fitMin, fitMax);
    const spanHi = Math.max(fitMin, fitMax);
    const mid = Math.round((spanLo + spanHi) / 2);
    minShift = Math.min(spanLo, mid - 6);
    maxShift = Math.max(spanHi, mid + 6);
  }

  if (Math.abs(minShift) > Number.MAX_SAFE_INTEGER || Math.abs(maxShift) > Number.MAX_SAFE_INTEGER) {
    throw new RangeError('A note has an octave offset too large to transpose.');
  }
  if (maxShift - minShift + 1 > MAX_CANDIDATES) {
    throw new RangeError('The melody spans too many octaves to rank. Check the octave offsets in the clip.');
  }

  const evaluated: EvaluatedCandidate[] = [];
  for (let shift = minShift; shift <= maxShift; shift++) {
    evaluated.push(evaluateCandidate(writtenBase, shift, profile));
  }

  evaluated.sort(compareEvaluated);

  const candidates = evaluated.map((e) => e.candidate);
  const best = candidates[0]!;
  const anyFits = candidates.some((c) => c.fits);

  return { best, candidates, anyFits };
}
