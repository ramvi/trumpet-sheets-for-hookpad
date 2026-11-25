import { describe, expect, it } from 'vitest';
import type { Mode, Pitch, Step } from './types';
import {
  MODE_INTERVALS,
  formatKey,
  formatPitch,
  formatPitchClass,
  keySignatureAlter,
  keySignatureFifths,
  pitchClassSemitone,
  pitchToMidi,
  simplifySpelling,
  transposePitch,
  transposePitchClass,
} from './pitch';

describe('pitchToMidi & pitchClassSemitone', () => {
  it('maps scientific pitches including enharmonic octave boundaries', () => {
    expect(pitchToMidi({ step: 'C', alter: 0, octave: 4 })).toBe(60);
    expect(pitchToMidi({ step: 'C', alter: -1, octave: 5 })).toBe(71);
    expect(pitchToMidi({ step: 'B', alter: 1, octave: 3 })).toBe(60);
    expect(pitchToMidi({ step: 'B', alter: 0, octave: 4 })).toBe(71);
    expect(pitchToMidi({ step: 'G', alter: 0, octave: 3 })).toBe(55);
    expect(pitchToMidi({ step: 'E', alter: -1, octave: 5 })).toBe(75);
    expect(pitchToMidi({ step: 'F', alter: 1, octave: 3 })).toBe(54);
    expect(pitchToMidi({ step: 'C', alter: 0, octave: 6 })).toBe(84);
    expect(pitchToMidi({ step: 'C', alter: -2, octave: 4 })).toBe(58);
    expect(pitchToMidi({ step: 'B', alter: 2, octave: 3 })).toBe(61);
  });

  it('normalizes pitchClassSemitone to 0..11', () => {
    expect(pitchClassSemitone({ step: 'C', alter: 0 })).toBe(0);
    expect(pitchClassSemitone({ step: 'C', alter: -1 })).toBe(11);
    expect(pitchClassSemitone({ step: 'C', alter: -2 })).toBe(10);
    expect(pitchClassSemitone({ step: 'B', alter: 1 })).toBe(0);
    expect(pitchClassSemitone({ step: 'B', alter: 2 })).toBe(1);
    expect(pitchClassSemitone({ step: 'E', alter: -1 })).toBe(3);
    expect(pitchClassSemitone({ step: 'F', alter: 1 })).toBe(6);
  });
});

describe('MODE_INTERVALS', () => {
  it('defines 7 sorted semitone offsets starting at 0 for every mode', () => {
    const expected: Record<Mode, number[]> = {
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
    expect(MODE_INTERVALS).toEqual(expected);
  });
});

describe('keySignatureFifths & keySignatureAlter', () => {
  it('computes standard and theoretical key signatures across all modes', () => {
    expect(keySignatureFifths({ step: 'C', alter: 0 }, 'major')).toBe(0);
    expect(keySignatureFifths({ step: 'D', alter: 0 }, 'major')).toBe(2);
    expect(keySignatureFifths({ step: 'C', alter: 0 }, 'minor')).toBe(-3);
    expect(keySignatureFifths({ step: 'D', alter: 0 }, 'dorian')).toBe(0);
    expect(keySignatureFifths({ step: 'B', alter: -1 }, 'minor')).toBe(-5);
    expect(keySignatureFifths({ step: 'A', alter: 0 }, 'harmonicMinor')).toBe(0);
    expect(keySignatureFifths({ step: 'C', alter: 0 }, 'harmonicMinor')).toBe(-3);
    expect(keySignatureFifths({ step: 'E', alter: 0 }, 'phrygianDominant')).toBe(0);
    expect(keySignatureFifths({ step: 'G', alter: 0 }, 'phrygianDominant')).toBe(-3);
    expect(keySignatureFifths({ step: 'F', alter: 0 }, 'lydian')).toBe(0);
    expect(keySignatureFifths({ step: 'G', alter: 0 }, 'mixolydian')).toBe(0);
    expect(keySignatureFifths({ step: 'B', alter: 0 }, 'locrian')).toBe(0);

    // Theoretical keys beyond ±7
    expect(keySignatureFifths({ step: 'G', alter: 1 }, 'major')).toBe(8);
    expect(keySignatureFifths({ step: 'F', alter: -1 }, 'major')).toBe(-8);
    expect(keySignatureFifths({ step: 'D', alter: -1 }, 'minor')).toBe(-8);
    expect(keySignatureFifths({ step: 'D', alter: 1 }, 'major')).toBe(9);
  });

  it('computes exact alterations for every signature from -7 to +7', () => {
    const sharpOrder: Step[] = ['F', 'C', 'G', 'D', 'A', 'E', 'B'];
    const flatOrder: Step[] = ['B', 'E', 'A', 'D', 'G', 'C', 'F'];

    for (let f = 0; f <= 7; f++) {
      const sharped = new Set(sharpOrder.slice(0, f));
      for (const step of sharpOrder) {
        expect(keySignatureAlter(f, step)).toBe(sharped.has(step) ? 1 : 0);
      }
    }
    for (let f = -1; f >= -7; f--) {
      const flatted = new Set(flatOrder.slice(0, -f));
      for (const step of flatOrder) {
        expect(keySignatureAlter(f, step)).toBe(flatted.has(step) ? -1 : 0);
      }
    }
  });
});

describe('transposePitch & transposePitchClass', () => {
  it('preserves spelled intervals across octaves and accidentals', () => {
    // Up a major second (+1 step, +2 semitones): concert -> written B♭ trumpet
    expect(transposePitch({ step: 'C', alter: 0, octave: 4 }, 1, 2)).toEqual({
      step: 'D',
      alter: 0,
      octave: 4,
    });
    expect(transposePitch({ step: 'B', alter: -1, octave: 4 }, 1, 2)).toEqual({
      step: 'C',
      alter: 0,
      octave: 5,
    });
    expect(transposePitch({ step: 'B', alter: 0, octave: 4 }, 1, 2)).toEqual({
      step: 'C',
      alter: 1,
      octave: 5,
    });
    expect(transposePitch({ step: 'C', alter: -1, octave: 5 }, 1, 2)).toEqual({
      step: 'D',
      alter: -1,
      octave: 5,
    });
    expect(transposePitch({ step: 'B', alter: 1, octave: 3 }, 1, 2)).toEqual({
      step: 'C',
      alter: 2,
      octave: 4,
    });

    // Down a major second (-1 step, -2 semitones)
    expect(transposePitch({ step: 'C', alter: 0, octave: 4 }, -1, -2)).toEqual({
      step: 'B',
      alter: -1,
      octave: 3,
    });
    expect(transposePitch({ step: 'D', alter: 0, octave: 4 }, -1, -2)).toEqual({
      step: 'C',
      alter: 0,
      octave: 4,
    });

    // Octave shifts
    expect(transposePitch({ step: 'E', alter: -1, octave: 4 }, 7, 12)).toEqual({
      step: 'E',
      alter: -1,
      octave: 5,
    });
    expect(transposePitch({ step: 'E', alter: -1, octave: 4 }, -7, -12)).toEqual({
      step: 'E',
      alter: -1,
      octave: 3,
    });
  });

  it('transposes pitch classes consistently with transposePitch', () => {
    expect(transposePitchClass({ step: 'C', alter: 0 }, 1, 2)).toEqual({ step: 'D', alter: 0 });
    expect(transposePitchClass({ step: 'B', alter: -1 }, 1, 2)).toEqual({ step: 'C', alter: 0 });
    expect(transposePitchClass({ step: 'C', alter: 0 }, -1, -2)).toEqual({ step: 'B', alter: -1 });
    expect(transposePitchClass({ step: 'F', alter: 1 }, 4, 7)).toEqual({ step: 'C', alter: 1 });
  });
});

describe('simplifySpelling', () => {
  it('leaves natural and single-accidental pitches untouched, including C♭/B♯/E♯/F♭', () => {
    const keep: Pitch[] = [
      { step: 'C', alter: 0, octave: 4 },
      { step: 'C', alter: -1, octave: 5 },
      { step: 'B', alter: 1, octave: 3 },
      { step: 'E', alter: 1, octave: 4 },
      { step: 'F', alter: -1, octave: 4 },
      { step: 'F', alter: 1, octave: 4 },
      { step: 'B', alter: -1, octave: 4 },
    ];
    for (const p of keep) {
      expect(simplifySpelling(p)).toEqual(p);
    }
  });

  it('re-spells every double sharp and double flat to |alter| <= 1 with identical MIDI', () => {
    const cases: Array<[Pitch, Pitch]> = [
      [{ step: 'C', alter: 2, octave: 4 }, { step: 'D', alter: 0, octave: 4 }],
      [{ step: 'D', alter: 2, octave: 4 }, { step: 'E', alter: 0, octave: 4 }],
      [{ step: 'E', alter: 2, octave: 4 }, { step: 'F', alter: 1, octave: 4 }],
      [{ step: 'F', alter: 2, octave: 4 }, { step: 'G', alter: 0, octave: 4 }],
      [{ step: 'G', alter: 2, octave: 4 }, { step: 'A', alter: 0, octave: 4 }],
      [{ step: 'A', alter: 2, octave: 4 }, { step: 'B', alter: 0, octave: 4 }],
      [{ step: 'B', alter: 2, octave: 3 }, { step: 'C', alter: 1, octave: 4 }],
      [{ step: 'C', alter: -2, octave: 5 }, { step: 'B', alter: -1, octave: 4 }],
      [{ step: 'D', alter: -2, octave: 4 }, { step: 'C', alter: 0, octave: 4 }],
      [{ step: 'E', alter: -2, octave: 4 }, { step: 'D', alter: 0, octave: 4 }],
      [{ step: 'F', alter: -2, octave: 4 }, { step: 'E', alter: -1, octave: 4 }],
      [{ step: 'G', alter: -2, octave: 4 }, { step: 'F', alter: 0, octave: 4 }],
      [{ step: 'A', alter: -2, octave: 4 }, { step: 'G', alter: 0, octave: 4 }],
      [{ step: 'B', alter: -2, octave: 4 }, { step: 'A', alter: 0, octave: 4 }],
    ];
    for (const [input, expected] of cases) {
      const simplified = simplifySpelling(input);
      expect(simplified).toEqual(expected);
      expect(pitchToMidi(simplified)).toBe(pitchToMidi(input));
      expect(Math.abs(simplified.alter)).toBeLessThanOrEqual(1);
    }
  });
});

describe('formatting', () => {
  it('formats pitches with either B or H naming', () => {
    const b: Pitch = { step: 'B', alter: 0, octave: 4 };
    const bFlat: Pitch = { step: 'B', alter: -1, octave: 4 };
    expect([formatPitch(b), formatPitch(b, 'H')]).toEqual(['B4', 'H4']);
    expect([formatPitch(bFlat), formatPitch(bFlat, 'H')]).toEqual(['B♭4', 'B♭4']);
    expect(formatPitch({ step: 'C', alter: -1, octave: 5 }, 'H')).toBe('C♭5');
    expect(formatPitchClass({ step: 'F', alter: 2 })).toBe('F𝄪');
  });

  it('formats keys', () => {
    const b = { step: 'B', alter: 0 } as const;
    expect(formatKey({ tonic: b, mode: 'minor' })).toBe('B minor');
    expect(formatKey({ tonic: b, mode: 'minor' }, 'H')).toBe('H minor');
    expect(formatKey({ tonic: { step: 'E', alter: -1 }, mode: 'phrygianDominant' })).toBe('E♭ Phrygian dominant');
  });
});
