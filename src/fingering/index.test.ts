import { describe, expect, it } from 'vitest';
import type { Pitch, Step } from '../model/types';
import { fingeringFor, fingeringLabel, isDemandingFingering, needsFingering } from './index';

function p(step: Step, octave: number, alter = 0): Pitch {
  return { step, alter, octave };
}

describe('fingeringFor', () => {
  const FULL_CHART: Array<[number, Pitch, string]> = [
    [54, p('F', 3, 1), '1+2+3'],
    [55, p('G', 3), '1+3'],
    [56, p('G', 3, 1), '2+3'],
    [57, p('A', 3), '1+2'],
    [58, p('B', 3, -1), '1'],
    [59, p('B', 3), '2'],
    [60, p('C', 4), '0'],
    [61, p('C', 4, 1), '1+2+3'],
    [62, p('D', 4), '1+3'],
    [63, p('E', 4, -1), '2+3'],
    [64, p('E', 4), '1+2'],
    [65, p('F', 4), '1'],
    [66, p('F', 4, 1), '2'],
    [67, p('G', 4), '0'],
    [68, p('A', 4, -1), '2+3'],
    [69, p('A', 4), '1+2'],
    [70, p('B', 4, -1), '1'],
    [71, p('B', 4), '2'],
    [72, p('C', 5), '0'],
    [73, p('C', 5, 1), '1+2'],
    [74, p('D', 5), '1'],
    [75, p('E', 5, -1), '2'],
    [76, p('E', 5), '0'],
    [77, p('F', 5), '1'],
    [78, p('F', 5, 1), '2'],
    [79, p('G', 5), '0'],
    [80, p('A', 5, -1), '2+3'],
    [81, p('A', 5), '1+2'],
    [82, p('B', 5, -1), '1'],
    [83, p('B', 5), '2'],
    [84, p('C', 6), '0'],
  ];

  it('matches the Yamaha B♭-trumpet chart for every semitone from F♯3 (54) to C6 (84)', () => {
    expect(FULL_CHART).toHaveLength(31);
    for (const [, pitch, expected] of FULL_CHART) {
      expect(fingeringFor(pitch)).toBe(expected);
    }
  });

  it('matches representative trumpet fingerings', () => {
    expect(fingeringFor(p('G', 3))).toBe('1+3');
    expect(fingeringFor(p('C', 4))).toBe('0');
    expect(fingeringFor(p('E', 4, -1))).toBe('2+3');
    expect(fingeringFor(p('E', 4))).toBe('1+2');
    expect(fingeringFor(p('F', 4, 1))).toBe('2');
    expect(fingeringFor(p('G', 4))).toBe('0');
    expect(fingeringFor(p('A', 4, -1))).toBe('2+3');
    expect(fingeringFor(p('B', 4, -1))).toBe('1');
    expect(fingeringFor(p('B', 4))).toBe('2');
    expect(fingeringFor(p('C', 5))).toBe('0');
    expect(fingeringFor(p('C', 5, 1))).toBe('1+2');
    expect(fingeringFor(p('D', 5))).toBe('1');
    expect(fingeringFor(p('E', 5, -1))).toBe('2');
    expect(fingeringFor(p('E', 5))).toBe('0');
  });

  it('returns null outside F♯3–C6', () => {
    expect(fingeringFor(p('F', 3))).toBeNull();
    expect(fingeringFor(p('E', 3))).toBeNull();
    expect(fingeringFor(p('C', 3))).toBeNull();
    expect(fingeringFor(p('C', 6, 1))).toBeNull();
    expect(fingeringFor(p('D', 6, -1))).toBeNull();
    expect(fingeringFor(p('G', 6))).toBeNull();
  });

  it('depends only on sounding height, never on spelling', () => {
    const pairs: Array<[Pitch, Pitch]> = [
      [p('C', 5, -1), p('B', 4)],
      [p('B', 3, 1), p('C', 4)],
      [p('G', 4, 1), p('A', 4, -1)],
      [p('F', 3, 1), p('G', 3, -1)],
      [p('D', 4, -1), p('C', 4, 1)],
      [p('D', 5, 1), p('E', 5, -1)],
      [p('E', 5, 1), p('F', 5)],
      [p('F', 5, -1), p('E', 5)],
      [p('B', 5, 1), p('C', 6)],
      [p('E', 4, 2), p('F', 4, 1)],
    ];
    for (const [a, b] of pairs) {
      expect(fingeringFor(a)).toBe(fingeringFor(b));
      expect(fingeringFor(a)).not.toBeNull();
    }
  });
});

describe('needsFingering & fingeringLabel', () => {
  it('omits plain naturals C4–C5 and prints everything else', () => {
    // Plain naturals in octave 4 -> false / null
    for (const step of ['C', 'D', 'E', 'F', 'G', 'A', 'B'] as const) {
      const pitch = p(step, 4, 0);
      expect(needsFingering(pitch)).toBe(false);
      expect(fingeringLabel(pitch)).toBeNull();
    }

    expect(fingeringLabel(p('C', 4))).toBeNull();
    expect(fingeringLabel(p('G', 4))).toBeNull();
    expect(fingeringLabel(p('E', 4))).toBeNull();

    expect(needsFingering(p('G', 3))).toBe(true);
    expect(fingeringLabel(p('G', 3))).toBe('1+3');

    expect(needsFingering(p('E', 4, -1))).toBe(true);
    expect(fingeringLabel(p('E', 4, -1))).toBe('2+3');

    expect(needsFingering(p('A', 4, -1))).toBe(true);
    expect(fingeringLabel(p('A', 4, -1))).toBe('2+3');

    expect(needsFingering(p('B', 4, -1))).toBe(true);
    expect(fingeringLabel(p('B', 4, -1))).toBe('1');

    expect(needsFingering(p('F', 4, 1))).toBe(true);
    expect(fingeringLabel(p('F', 4, 1))).toBe('2');

    expect(needsFingering(p('C', 5))).toBe(false);
    expect(fingeringLabel(p('C', 5))).toBeNull();
    expect(fingeringLabel(p('B', 4, 1))).toBe('0');
    expect(fingeringLabel(p('D', 5))).toBe('1');

    expect(needsFingering(p('C', 5, -1))).toBe(true);
    expect(fingeringLabel(p('C', 5, -1))).toBe('2');

    // Enharmonic spelling of C4 as B♯3 has alter != 0 and octave != 4
    expect(needsFingering(p('B', 3, 1))).toBe(true);
    expect(fingeringLabel(p('B', 3, 1))).toBe('0');
  });

  it('returns null from fingeringLabel when outside the fingering range', () => {
    expect(needsFingering(p('F', 3))).toBe(true);
    expect(fingeringLabel(p('F', 3))).toBeNull();
    expect(needsFingering(p('D', 6))).toBe(true);
    expect(fingeringLabel(p('D', 6))).toBeNull();
  });
});

describe('isDemandingFingering', () => {
  it('flags exactly the third-valve combinations (2+3, 1+3, 1+2+3)', () => {
    // Demanding pitches in F♯3–C6
    const demanding: Pitch[] = [
      p('F', 3, 1), // 1+2+3
      p('G', 3), // 1+3
      p('A', 3, -1), // 2+3
      p('C', 4, 1), // 1+2+3
      p('D', 4), // 1+3
      p('E', 4, -1), // 2+3
      p('A', 4, -1), // 2+3
      p('A', 5, -1), // 2+3
    ];
    for (const pitch of demanding) {
      expect(isDemandingFingering(pitch)).toBe(true);
    }

    // Non-demanding pitches (0, 1, 2, 1+2)
    const easy: Pitch[] = [
      p('A', 3), // 1+2
      p('B', 3, -1), // 1
      p('B', 3), // 2
      p('C', 4), // 0
      p('E', 4), // 1+2
      p('F', 4), // 1
      p('F', 4, 1), // 2
      p('G', 4), // 0
      p('A', 4), // 1+2
      p('B', 4, -1), // 1
      p('B', 4), // 2
      p('C', 5), // 0
      p('C', 5, 1), // 1+2
      p('D', 5), // 1
      p('E', 5, -1), // 2
      p('E', 5), // 0
      p('C', 6), // 0
    ];
    for (const pitch of easy) {
      expect(isDemandingFingering(pitch)).toBe(false);
    }

    // Out-of-range pitches return false
    expect(isDemandingFingering(p('F', 3))).toBe(false);
    expect(isDemandingFingering(p('D', 6))).toBe(false);
  });
});
