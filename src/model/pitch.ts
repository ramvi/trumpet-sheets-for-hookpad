import type { Mode, Pitch, PitchClass, Step } from './types';

export const STEP_ORDER: readonly Step[] = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];

const STEP_INDEX: Record<Step, number> = {
  C: 0,
  D: 1,
  E: 2,
  F: 3,
  G: 4,
  A: 5,
  B: 6,
};

const STEP_SEMITONE: Record<Step, number> = {
  C: 0,
  D: 2,
  E: 4,
  F: 5,
  G: 7,
  A: 9,
  B: 11,
};

const STEP_FIFTHS: Record<Step, number> = {
  F: -1,
  C: 0,
  G: 1,
  D: 2,
  A: 3,
  E: 4,
  B: 5,
};

const MODE_FIFTHS_OFFSET: Record<Mode, number> = {
  lydian: 1,
  major: 0,
  mixolydian: -1,
  dorian: -2,
  minor: -3,
  harmonicMinor: -3,
  phrygian: -4,
  phrygianDominant: -4,
  locrian: -5,
};

export const MODE_INTERVALS: Record<Mode, number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  minor: [0, 2, 3, 5, 7, 8, 10],
  locrian: [0, 1, 3, 5, 6, 8, 10],
  harmonicMinor: [0, 2, 3, 5, 7, 8, 11],
  phrygianDominant: [0, 1, 4, 5, 7, 8, 10],
};

export function pitchToMidi(p: Pitch): number {
  return (p.octave + 1) * 12 + STEP_SEMITONE[p.step] + p.alter;
}

export function pitchClassSemitone(pc: PitchClass): number {
  return (((STEP_SEMITONE[pc.step] + pc.alter) % 12) + 12) % 12;
}

/**
 * Position on the circle of fifths of the conventional key signature
 * (negative = flats, positive = sharps). Works for theoretical keys beyond ±7.
 * harmonicMinor uses the natural-minor signature; phrygianDominant uses the phrygian signature.
 */
export function keySignatureFifths(tonic: PitchClass, mode: Mode): number {
  return STEP_FIFTHS[tonic.step] + tonic.alter * 7 + MODE_FIFTHS_OFFSET[mode];
}

/**
 * Alteration that a key signature with `fifths` sharps (>0) or flats (<0)
 * applies to `step`. Exact for all standard signatures (|fifths| <= 7) and
 * naturally generalizes beyond ±7.
 */
export function keySignatureAlter(fifths: number, step: Step): number {
  return Math.floor((fifths - STEP_FIFTHS[step] + 5) / 7);
}

export function transposePitch(p: Pitch, diatonicSteps: number, semitones: number): Pitch {
  const totalSteps = STEP_INDEX[p.step] + diatonicSteps;
  const octaveDelta = Math.floor(totalSteps / 7);
  const newStepIndex = ((totalSteps % 7) + 7) % 7;
  const newStep = STEP_ORDER[newStepIndex]!;
  const newOctave = p.octave + octaveDelta;
  const targetMidi = pitchToMidi(p) + semitones;
  const naturalMidi = (newOctave + 1) * 12 + STEP_SEMITONE[newStep];
  return {
    step: newStep,
    alter: targetMidi - naturalMidi,
    octave: newOctave,
  };
}

export function transposePitchClass(
  pc: PitchClass,
  diatonicSteps: number,
  semitones: number,
): PitchClass {
  const transposed = transposePitch({ step: pc.step, alter: pc.alter, octave: 4 }, diatonicSteps, semitones);
  return { step: transposed.step, alter: transposed.alter };
}

export function diatonicStepsBetween(fromTonic: PitchClass, toTonic: PitchClass, semitones: number): number {
  const fromSemi = STEP_SEMITONE[fromTonic.step] + fromTonic.alter;
  const toSemi = STEP_SEMITONE[toTonic.step] + toTonic.alter;
  const octaveDelta = (fromSemi + semitones - toSemi) / 12;
  return 7 * octaveDelta + STEP_INDEX[toTonic.step] - STEP_INDEX[fromTonic.step];
}

const NATURAL_STEP_BY_SEMITONE: Record<number, Step | undefined> = {
  0: 'C',
  2: 'D',
  4: 'E',
  5: 'F',
  7: 'G',
  9: 'A',
  11: 'B',
};

const SHARP_SPELLING_BY_SEMITONE: Record<number, Step> = {
  1: 'C',
  3: 'D',
  6: 'F',
  8: 'G',
  10: 'A',
};

const FLAT_SPELLING_BY_SEMITONE: Record<number, Step> = {
  1: 'D',
  3: 'E',
  6: 'G',
  8: 'A',
  10: 'B',
};

/**
 * Re-spells double sharps/flats (|alter| > 1) — and only those — to the simplest
 * enharmonic equivalent with |alter| <= 1 and the same MIDI height.
 */
export function simplifySpelling(p: Pitch): Pitch {
  if (Math.abs(p.alter) <= 1) {
    return { step: p.step, alter: p.alter, octave: p.octave };
  }
  const midi = pitchToMidi(p);
  const pc = ((midi % 12) + 12) % 12;
  const octave = Math.floor(midi / 12) - 1;
  const naturalStep = NATURAL_STEP_BY_SEMITONE[pc];
  if (naturalStep !== undefined) {
    return { step: naturalStep, alter: 0, octave };
  }
  if (p.alter > 0) {
    return { step: SHARP_SPELLING_BY_SEMITONE[pc]!, alter: 1, octave };
  }
  return { step: FLAT_SPELLING_BY_SEMITONE[pc]!, alter: -1, octave };
}

function formatAccidental(alter: number): string {
  if (alter === 0) return '';
  if (alter === 1) return '♯';
  if (alter === -1) return '♭';
  if (alter === 2) return '𝄪';
  if (alter === -2) return '𝄫';
  return alter > 0 ? '♯'.repeat(alter) : '♭'.repeat(-alter);
}

/** How B natural is printed: English "B" or Nordic/German "H". B flat is always "B♭". */
export type NoteNaming = 'B' | 'H';

export function formatPitchClass(pc: PitchClass, naming: NoteNaming = 'B'): string {
  const letter = naming === 'H' && pc.step === 'B' && pc.alter >= 0 ? 'H' : pc.step;
  return `${letter}${formatAccidental(pc.alter)}`;
}

export function formatPitch(p: Pitch, naming?: NoteNaming): string {
  return `${formatPitchClass(p, naming)}${p.octave}`;
}

const MODE_LABEL: Record<Mode, string> = {
  major: 'major',
  minor: 'minor',
  dorian: 'Dorian',
  phrygian: 'Phrygian',
  lydian: 'Lydian',
  mixolydian: 'Mixolydian',
  locrian: 'Locrian',
  harmonicMinor: 'harmonic minor',
  phrygianDominant: 'Phrygian dominant',
};

export function formatKey(key: { tonic: PitchClass; mode: Mode }, naming?: NoteNaming): string {
  return `${formatPitchClass(key.tonic, naming)} ${MODE_LABEL[key.mode]}`;
}
