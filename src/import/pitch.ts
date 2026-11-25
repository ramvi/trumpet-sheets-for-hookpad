import { MODE_INTERVALS, pitchToMidi, transposePitch } from '../model/pitch';
import type { KeyChange, Mode, Pitch, PitchClass, Step } from '../model/types';
import { ImportError } from './errors';

/**
 * Octave convention for Hookpad's `octave: 0` tonic placement.
 *
 * Assumption: with `octave: 0`, the key's tonic sits in the octave closest to
 * middle C (C4 = MIDI 60), breaking the tritone tie upward so pitch classes
 * C..F♯/G♭ sit in octave 4 (MIDI 60..66) and G..B sit in octave 3 (MIDI 55..59).
 * Scale degrees 1..7 ascend from that tonic, and Hookpad's `octave` shifts by
 * whole octaves (12 semitones / 7 letters).
 */
const DEFAULT_TONIC_MIDI_LOW = 55; // G3; range is [55, 66] = G3..F♯4/G♭4

function defaultTonicOctave(tonic: PitchClass): number {
  const midiAtOctave4 = pitchToMidi({ step: tonic.step, alter: tonic.alter, octave: 4 });
  return 4 - Math.floor((midiAtOctave4 - DEFAULT_TONIC_MIDI_LOW) / 12);
}

const VALID_STEPS: Readonly<Record<string, Step>> = {
  C: 'C',
  D: 'D',
  E: 'E',
  F: 'F',
  G: 'G',
  A: 'A',
  B: 'B',
};

const SCALE_MAP: Readonly<Record<string, Mode>> = {
  major: 'major',
  minor: 'minor',
  dorian: 'dorian',
  phrygian: 'phrygian',
  lydian: 'lydian',
  mixolydian: 'mixolydian',
  locrian: 'locrian',
  harmonicminor: 'harmonicMinor',
  phrygiandominant: 'phrygianDominant',
};

function parseAccidentalString(acc: string): number {
  let alter = 0;
  for (const ch of acc) {
    if (ch === '#' || ch === '♯') {
      alter += 1;
    } else if (ch === 'b' || ch === '♭') {
      alter -= 1;
    }
  }
  return alter;
}

export function parseTonic(rawTonic: unknown): PitchClass {
  if (rawTonic === undefined || rawTonic === null) {
    throw new ImportError(
      'missing-key',
      'A key is missing its tonic. Copy the melody from Hookpad again.',
    );
  }
  if (typeof rawTonic !== 'string') {
    throw new ImportError(
      'unsupported',
      `A key has an invalid tonic ("${String(rawTonic)}").`,
    );
  }
  const trimmed = rawTonic.trim();
  if (trimmed.length === 0) {
    throw new ImportError(
      'missing-key',
      'A key is missing its tonic. Copy the melody from Hookpad again.',
    );
  }
  const match = /^([A-Ga-g])([#♯b♭]*)$/.exec(trimmed);
  if (!match) {
    throw new ImportError(
      'unsupported',
      `A key has an invalid tonic ("${trimmed}").`,
    );
  }
  const step = VALID_STEPS[match[1]!.toUpperCase()]!;
  const alter = parseAccidentalString(match[2]!);
  return { step, alter };
}

export function parseMode(rawScale: unknown): Mode {
  if (typeof rawScale !== 'string' || rawScale.trim().length === 0) {
    throw new ImportError(
      'unsupported',
      `A key has a missing or invalid scale ("${rawScale === undefined || rawScale === null ? '' : String(rawScale)}").`,
    );
  }
  const normalized = rawScale.trim().toLowerCase().replace(/[\s_-]+/g, '');
  const mode = SCALE_MAP[normalized];
  if (!mode) {
    throw new ImportError(
      'unsupported',
      `The scale "${rawScale.trim()}" is unsupported.`,
    );
  }
  return mode;
}

interface ParsedScaleDegree {
  degree: number; // 1..7
  accidentalAlter: number; // sum of leading #/b
}

function parseScaleDegree(rawSd: unknown): ParsedScaleDegree {
  if (typeof rawSd !== 'string') {
    throw new ImportError(
      'unsupported',
      `A note has an invalid scale degree ("${String(rawSd)}").`,
    );
  }
  const trimmed = rawSd.trim();
  const match = /^([#♯b♭]*)([1-7])$/.exec(trimmed);
  if (!match) {
    throw new ImportError(
      'unsupported',
      `A note has an invalid scale degree ("${trimmed}").`,
    );
  }
  return {
    degree: Number(match[2]!),
    accidentalAlter: parseAccidentalString(match[1]!),
  };
}

export function resolveScaleDegreePitch(
  rawSd: unknown,
  octaveOffset: number,
  key: Pick<KeyChange, 'tonic' | 'mode'>,
): Pitch {
  const { degree, accidentalAlter } = parseScaleDegree(rawSd);
  const tonicPitch: Pitch = {
    step: key.tonic.step,
    alter: key.tonic.alter,
    octave: defaultTonicOctave(key.tonic),
  };
  const diatonicSteps = (degree - 1) + octaveOffset * 7;
  const semitones = MODE_INTERVALS[key.mode][degree - 1]! + accidentalAlter + octaveOffset * 12;
  return transposePitch(tonicPitch, diatonicSteps, semitones);
}
