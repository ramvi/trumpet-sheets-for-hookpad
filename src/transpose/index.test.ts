import { describe, expect, it } from 'vitest';
import { importHookpad } from '../import';
import {
  lowFiveNote,
  referenceMelody,
  tieAndTriplet,
  wideMelody,
  withKeyChange,
  withRestsAndGap,
} from '../../tests/melodies';
import { pitchToMidi, transposePitch, transposePitchClass } from '../model/pitch';
import type { Melody } from '../model/types';
import { buildNotation } from '../notation';
import {
  DEFAULT_PROFILE,
  RANKING_WEIGHTS,
  concertKeyFor,
  rankCandidates,
  toWrittenBase,
  transposeMelody,
} from './index';

function toConcertCopy(written: Melody): Melody {
  return {
    ...written,
    keys: written.keys.map((k) => ({
      ...k,
      tonic: transposePitchClass(k.tonic, -1, -2),
    })),
    meters: written.meters.map((m) => ({ ...m })),
    tuplets: written.tuplets.map((t) => ({ ...t })),
    events: written.events.map((ev) => ({
      ...ev,
      pitch: ev.pitch ? transposePitch(ev.pitch, -1, -2) : null,
    })),
  };
}

describe('concertKeyFor', () => {
  it('moves written trumpet key down a major second with conventional spelling', () => {
    expect(concertKeyFor({ tonic: { step: 'C', alter: 0 }, mode: 'minor' })).toEqual({
      tonic: { step: 'B', alter: -1 },
      mode: 'minor',
    });
    expect(concertKeyFor({ tonic: { step: 'D', alter: 0 }, mode: 'major' })).toEqual({
      tonic: { step: 'C', alter: 0 },
      mode: 'major',
    });
    expect(concertKeyFor({ tonic: { step: 'C', alter: 0 }, mode: 'major' })).toEqual({
      tonic: { step: 'B', alter: -1 },
      mode: 'major',
    });
    // G♭ major -> E major (not F♭ major)
    expect(concertKeyFor({ tonic: { step: 'G', alter: -1 }, mode: 'major' })).toEqual({
      tonic: { step: 'E', alter: 0 },
      mode: 'major',
    });
    // A♭ major -> G♭ major (6♭ beats 6♯ tie)
    expect(concertKeyFor({ tonic: { step: 'A', alter: -1 }, mode: 'major' })).toEqual({
      tonic: { step: 'G', alter: -1 },
      mode: 'major',
    });
    // B♭ minor -> G♯ minor (5♯ beats A♭ minor 7♭)
    expect(concertKeyFor({ tonic: { step: 'B', alter: -1 }, mode: 'minor' })).toEqual({
      tonic: { step: 'G', alter: 1 },
      mode: 'minor',
    });
  });
});

describe('toWrittenBase', () => {
  it('leaves written input unchanged', () => {
    const before = structuredClone(referenceMelody);
    const out = toWrittenBase(referenceMelody, 'written');
    expect(out).toEqual(referenceMelody);
    expect(referenceMelody).toEqual(before);
  });

  it('transposes concert pitch up a major second (+1 letter, +2 semitones) including single-note B♭3 -> C4', () => {
    const singleConcert: Melody = {
      keys: [{ tick: 0, tonic: { step: 'B', alter: -1 }, mode: 'major' }],
      meters: [{ tick: 0, numerator: 4, denominator: 4 }],
      tuplets: [],
      events: [{ tick: 0, durationTicks: 480, pitch: { step: 'B', alter: -1, octave: 3 } }],
      endTick: 480,
    };
    const written = toWrittenBase(singleConcert, 'concert');
    expect(written.keys[0]!.tonic).toEqual({ step: 'C', alter: 0 });
    expect(written.events[0]!.pitch).toEqual({ step: 'C', alter: 0, octave: 4 });
  });

  it('round-trips the concert version of referenceMelody back to deep-equal referenceMelody', () => {
    const sounding = toConcertCopy(referenceMelody);
    expect(sounding.keys[0]).toEqual({
      tick: 0,
      tonic: { step: 'B', alter: -1 },
      mode: 'minor',
    });
    const snapshot = structuredClone(sounding);

    const written = toWrittenBase(sounding, 'concert');
    expect(written).toEqual(referenceMelody);
    expect(sounding).toEqual(snapshot);

    const ranking = rankCandidates(written, DEFAULT_PROFILE);
    expect(ranking.best.semitones).toBe(0);
    expect(ranking.best.score).toBeCloseTo(141.5, 6);
  });
});

describe('transposeMelody', () => {
  it('returns an equal copy for shift 0 without mutating input', () => {
    const snapshot = structuredClone(referenceMelody);
    const shifted = transposeMelody(referenceMelody, 0);
    expect(shifted).toEqual(referenceMelody);
    expect(shifted).not.toBe(referenceMelody);
    expect(referenceMelody).toEqual(snapshot);
  });

  it('preserves spelled intervals (C♭5 in C minor -> D♭5 in D minor) and eliminates double accidentals for -12..+12', () => {
    const snapshot = structuredClone(referenceMelody);
    const dMinor = transposeMelody(referenceMelody, 2);
    expect(dMinor.keys[0]).toEqual({
      tick: 0,
      tonic: { step: 'D', alter: 0 },
      mode: 'minor',
    });

    // Find the C♭5 event in referenceMelody
    const cb5Index = referenceMelody.events.findIndex(
      (ev) => ev.pitch?.step === 'C' && ev.pitch.alter === -1 && ev.pitch.octave === 5,
    );
    expect(cb5Index).toBeGreaterThan(-1);
    expect(dMinor.events[cb5Index]!.pitch).toEqual({ step: 'D', alter: -1, octave: 5 });

    // Check every shift -12..+12 on referenceMelody
    for (let shift = -12; shift <= 12; shift++) {
      const shifted = transposeMelody(referenceMelody, shift);
      expect(shifted.tuplets).toEqual(referenceMelody.tuplets);
      expect(shifted.meters).toEqual(referenceMelody.meters);
      expect(shifted.endTick).toBe(referenceMelody.endTick);
      expect(shifted.events).toHaveLength(referenceMelody.events.length);

      for (let i = 0; i < referenceMelody.events.length; i++) {
        const orig = referenceMelody.events[i]!;
        const next = shifted.events[i]!;
        expect(next.tick).toBe(orig.tick);
        expect(next.durationTicks).toBe(orig.durationTicks);

        if (orig.pitch === null) {
          expect(next.pitch).toBeNull();
        } else {
          expect(next.pitch).not.toBeNull();
          expect(Math.abs(next.pitch!.alter)).toBeLessThanOrEqual(1);
          expect(pitchToMidi(next.pitch!)).toBe(pitchToMidi(orig.pitch) + shift);
        }
      }
    }

    expect(referenceMelody).toEqual(snapshot);
  });

  it('gives every key a printable signature, also without a shift', () => {
    const gSharpMajor: Melody = {
      ...lowFiveNote,
      keys: [{ tick: 0, tonic: { step: 'G', alter: 1 }, mode: 'major' }],
      events: [{ tick: 0, durationTicks: 480, pitch: { step: 'B', alter: 1, octave: 3 } }],
    };
    const same = transposeMelody(gSharpMajor, 0);
    expect(same.keys[0]!.tonic).toEqual({ step: 'A', alter: -1 });
    expect(same.events[0]!.pitch).toEqual({ step: 'C', alter: 0, octave: 4 });
  });

  it('spells each key region on its own', () => {
    const shifted = transposeMelody(withKeyChange, -4); // C major, then A♭ major
    expect(shifted.keys.map((k) => k.tonic)).toEqual([
      { step: 'A', alter: -1 },
      { step: 'E', alter: 0 }, // not F♭ major
    ]);
    const second = shifted.events.filter((e) => e.tick >= 3840);
    expect(second[0]!.pitch).toEqual({ step: 'E', alter: 0, octave: 4 });
    expect(second.every((e) => e.pitch!.alter >= 0)).toBe(true);
  });

  it('moves both keys in withKeyChange by the same interval with positions unchanged', () => {
    const shifted = transposeMelody(withKeyChange, 2);
    expect(shifted.keys).toEqual([
      { tick: 0, tonic: { step: 'D', alter: 0 }, mode: 'major' },
      { tick: 3840, tonic: { step: 'B', alter: -1 }, mode: 'major' },
    ]);

    const shiftedDown = transposeMelody(withKeyChange, -3);
    expect(shiftedDown.keys).toEqual([
      { tick: 0, tonic: { step: 'A', alter: 0 }, mode: 'major' },
      { tick: 3840, tonic: { step: 'F', alter: 0 }, mode: 'major' },
    ]);
  });

  it('preserves explicit rests, implicit gaps, and tuplets', () => {
    const shiftedRests = transposeMelody(withRestsAndGap, 5);
    expect(shiftedRests.events[1]!.pitch).toBeNull();
    expect(shiftedRests.events[2]!.tick).toBe(withRestsAndGap.events[2]!.tick);
    expect(shiftedRests.events[3]!.tick).toBe(withRestsAndGap.events[3]!.tick);

    const shiftedTuplet = transposeMelody(tieAndTriplet, -2);
    expect(shiftedTuplet.tuplets).toEqual(tieAndTriplet.tuplets);
    expect(shiftedTuplet.events.map((e) => e.durationTicks)).toEqual(
      tieAndTriplet.events.map((e) => e.durationTicks),
    );
  });
});

describe('rankCandidates', () => {
  it('ranks the written reference melody with exact scores', () => {
    const ranking = rankCandidates(referenceMelody, DEFAULT_PROFILE);

    expect(ranking.anyFits).toBe(true);
    expect(ranking.best.semitones).toBe(0);
    expect(ranking.best.fits).toBe(true);
    expect(ranking.best.writtenKey).toEqual({
      tick: 0,
      tonic: { step: 'C', alter: 0 },
      mode: 'minor',
    });
    expect(ranking.best.hookpadKey).toEqual({
      tonic: { step: 'B', alter: -1 },
      mode: 'minor',
    });
    expect(ranking.best.lowest).toEqual({ step: 'G', alter: 0, octave: 3 });
    expect(ranking.best.highest).toEqual({ step: 'E', alter: -1, octave: 5 });
    expect(ranking.best.outOfRange).toEqual([]);
    expect(ranking.best.overflowTotal).toBe(0);
    expect(ranking.best.score).toBeCloseTo(141.5, 6);
    expect(ranking.best.combinedScore).toBeCloseTo(2.5073, 4);

    // Only shift 0 fits
    const fitting = ranking.candidates.filter((c) => c.fits);
    expect(fitting.map((c) => c.semitones)).toEqual([0]);

    const shiftPlus2 = ranking.candidates.find((c) => c.semitones === 2);
    const shiftMinus1 = ranking.candidates.find((c) => c.semitones === -1);
    expect(shiftPlus2).toBeDefined();
    expect(shiftPlus2!.fits).toBe(false);
    expect(shiftPlus2!.score).toBeCloseTo(210.75, 6);

    expect(shiftMinus1).toBeDefined();
    expect(shiftMinus1!.fits).toBe(false);
    expect(shiftMinus1!.score).toBeCloseTo(153.25, 6);
  });

  it('scores the same whichever note value a beat is written as', () => {
    const inEighths: Melody = {
      ...referenceMelody,
      meters: [{ tick: 0, numerator: 4, denominator: 8 }],
      tuplets: [],
      events: referenceMelody.events.map((e) => ({ ...e, tick: e.tick / 2, durationTicks: e.durationTicks / 2 })),
    };
    const scores = (m: Melody) => rankCandidates(m).candidates.map((c) => [c.semitones, c.combinedScore]);
    expect(scores(inEighths)).toEqual(scores(referenceMelody));
  });

  it('ranks lowFiveNote into D4–B♭4 choosing shift +7 (G major, combinedScore 0.22) over +8 (A♭ major, 0.68)', () => {
    const ranking = rankCandidates(lowFiveNote, DEFAULT_PROFILE);

    expect(ranking.anyFits).toBe(true);
    expect(ranking.best.semitones).toBe(7);
    expect(ranking.best.writtenKey).toEqual({
      tick: 0,
      tonic: { step: 'G', alter: 0 },
      mode: 'major',
    });
    expect(ranking.best.score).toBe(0);
    expect(ranking.best.combinedScore).toBeCloseTo(0.22, 6);
    expect(ranking.best.tiebreak.centerDistance).toBe(22);

    // Entirely inside preferred D4..B♭4 (62..70)
    expect(pitchToMidi(ranking.best.lowest)).toBeGreaterThanOrEqual(62);
    expect(pitchToMidi(ranking.best.highest)).toBeLessThanOrEqual(70);
    expect(ranking.best.melody.events.map((e) => e.pitch)).toEqual([
      { step: 'D', alter: 0, octave: 4 },
      { step: 'E', alter: 0, octave: 4 },
      { step: 'F', alter: 1, octave: 4 },
      { step: 'G', alter: 0, octave: 4 },
      { step: 'A', alter: 0, octave: 4 },
    ]);

    // Melodic intervals preserved
    const origMidis = lowFiveNote.events.map((e) => pitchToMidi(e.pitch!));
    const bestMidis = ranking.best.melody.events.map((e) => pitchToMidi(e.pitch!));
    for (let i = 1; i < origMidis.length; i++) {
      expect(bestMidis[i]! - bestMidis[i - 1]!).toBe(origMidis[i]! - origMidis[i - 1]!);
    }

    // Confirm shift +8 (A♭ major) has score 0, centerDistance 20, and combinedScore 0.68
    const shift8 = ranking.candidates.find((c) => c.semitones === 8);
    expect(shift8).toBeDefined();
    expect(shift8!.score).toBe(0);
    expect(shift8!.tiebreak.centerDistance).toBe(20);
    expect(shift8!.combinedScore).toBeCloseTo(0.68, 6);
    expect(ranking.candidates.indexOf(shift8!)).toBeGreaterThan(0);
  });

  it('handles wideMelody: no candidate fits default limits, ordered by overflowTotal, fits when widened', () => {
    const ranking = rankCandidates(wideMelody, DEFAULT_PROFILE);

    expect(ranking.anyFits).toBe(false);
    expect(ranking.best.fits).toBe(false);
    expect(ranking.best.outOfRange.length).toBeGreaterThan(0);

    // Verify all candidates are non-fitting and non-decreasing in overflowTotal
    for (let i = 1; i < ranking.candidates.length; i++) {
      expect(ranking.candidates[i]!.fits).toBe(false);
      expect(ranking.candidates[i]!.overflowTotal).toBeGreaterThanOrEqual(
        ranking.candidates[i - 1]!.overflowTotal,
      );
    }

    // Shift 0 has F♯3 (1 below 55) and E5 (1 above 75) -> overflowTotal 2
    const shift0 = ranking.candidates.find((c) => c.semitones === 0)!;
    expect(shift0.overflowTotal).toBe(2);
    expect(shift0.outOfRange).toEqual([
      {
        pitch: { step: 'F', alter: 1, octave: 3 },
        semitonesOutside: 1,
        side: 'low',
      },
      {
        pitch: { step: 'E', alter: 0, octave: 5 },
        semitonesOutside: 1,
        side: 'high',
      },
    ]);

    // Widening limits to F♯3–E5 (54..76) makes wideMelody fit
    const widened = rankCandidates(wideMelody, {
      ...DEFAULT_PROFILE,
      limitLow: 54,
      limitHigh: 76,
    });
    expect(widened.anyFits).toBe(true);
    expect(widened.best.fits).toBe(true);
    expect(widened.best.semitones).toBe(0);
    expect(widened.best.outOfRange).toEqual([]);
  });

  it('reacts to profile changes: lowered limitHigh on referenceMelody and shifted profile on lowFiveNote', () => {
    const strictHigh = rankCandidates(referenceMelody, {
      ...DEFAULT_PROFILE,
      limitHigh: 72,
    });
    expect(strictHigh.anyFits).toBe(false);
    expect(strictHigh.best.fits).toBe(false);
    expect(strictHigh.best.outOfRange.length).toBeGreaterThan(0);

    // At shift 0, the high notes (> 72) in referenceMelody are reported with side === 'high'
    const shift0 = strictHigh.candidates.find((c) => c.semitones === 0)!;
    expect(shift0.outOfRange.length).toBeGreaterThan(0);
    expect(shift0.outOfRange.every((n) => n.side === 'high')).toBe(true);
    expect(shift0.outOfRange.map((n) => pitchToMidi(n.pitch))).toEqual([75, 74]);

    // A narrower melody reacts to profile center/preferred changes by choosing a different shift
    const lowerProfile = {
      ...DEFAULT_PROFILE,
      center: 62,
      preferredLow: 58,
      preferredHigh: 66,
      comfortLow: 56,
      comfortHigh: 68,
    };
    const lowRanking = rankCandidates(lowFiveNote, lowerProfile);
    expect(lowRanking.anyFits).toBe(true);
    expect(lowRanking.best.semitones).not.toBe(7);
    expect(lowRanking.best.semitones).toBe(5); // C4..G4 in F major (1♭, 0 demanding, score 0)
  });

  it('does not count explicit rests in score, overflow, or hard fingerings', () => {
    const ranking = rankCandidates(withRestsAndGap, DEFAULT_PROFILE);
    expect(ranking.anyFits).toBe(true);
    // Explicitly confirm the rest event stays null in the winning melody
    expect(ranking.best.melody.events[1]!.pitch).toBeNull();
  });

  it('prefers flats on 6♯/6♭ key-signature ties in transposeMelody', () => {
    const cMajor: Melody = {
      keys: [{ tick: 0, tonic: { step: 'C', alter: 0 }, mode: 'major' }],
      meters: [{ tick: 0, numerator: 4, denominator: 4 }],
      tuplets: [],
      events: [{ tick: 0, durationTicks: 480, pitch: { step: 'C', alter: 0, octave: 4 } }],
      endTick: 480,
    };
    const tritoneMajor = transposeMelody(cMajor, 6);
    expect(tritoneMajor.keys[0]!.tonic).toEqual({ step: 'G', alter: -1 }); // G♭ major (-6) over F♯ major (+6)

    const aMinor: Melody = {
      ...cMajor,
      keys: [{ tick: 0, tonic: { step: 'A', alter: 0 }, mode: 'minor' }],
    };
    const tritoneMinor = transposeMelody(aMinor, 6);
    expect(tritoneMinor.keys[0]!.tonic).toEqual({ step: 'E', alter: -1 }); // E♭ minor (-6) over D♯ minor (+6)
  });

  it('counts bar-scoped local accidentals accurately across repeated notes, cancellations, octaves, and meter changes', () => {
    // 3/4 bar = 1440 ticks, then 4/4 from tick 1440 (bar 2 = 1440..3360)
    const melody: Melody = {
      keys: [{ tick: 0, tonic: { step: 'C', alter: 0 }, mode: 'major' }],
      meters: [
        { tick: 0, numerator: 3, denominator: 4 },
        { tick: 1440, numerator: 4, denominator: 4 },
      ],
      tuplets: [],
      events: [
        // Bar 1 (0..1440): F♯4 (prints ♯), F♯4 (same bar & octave -> no print), F♮4 (cancels -> prints ♮)
        { tick: 0, durationTicks: 480, pitch: { step: 'F', alter: 1, octave: 4 } },
        { tick: 480, durationTicks: 480, pitch: { step: 'F', alter: 1, octave: 4 } },
        { tick: 960, durationTicks: 480, pitch: { step: 'F', alter: 0, octave: 4 } },
        // Bar 2 (1440..3360): F♯4 (new bar -> prints ♯), F♯5 (different octave -> prints ♯), F♯4 (still active -> no print)
        { tick: 1440, durationTicks: 480, pitch: { step: 'F', alter: 1, octave: 4 } },
        { tick: 1920, durationTicks: 480, pitch: { step: 'F', alter: 1, octave: 5 } },
        { tick: 2400, durationTicks: 480, pitch: { step: 'F', alter: 1, octave: 4 } },
      ],
      endTick: 2880,
    };

    const ranking = rankCandidates(melody, { ...DEFAULT_PROFILE, limitHigh: 84 });
    const shift0 = ranking.candidates.find((c) => c.semitones === 0)!;
    // Key sig C major = 0, local printed accidentals = 2 (bar 1) + 2 (bar 2) = 4
    expect(shift0.tiebreak.accidentals).toBe(4);
  });

  it('counts the same courtesy accidentals as the sheet across a meter change and an empty bar', () => {
    const melody: Melody = {
      keys: [{ tick: 0, tonic: { step: 'C', alter: 0 }, mode: 'major' }],
      meters: [{ tick: 0, numerator: 4, denominator: 4 }, { tick: 1440, numerator: 3, denominator: 4 }],
      tuplets: [],
      events: [
        { tick: 960, durationTicks: 720, pitch: { step: 'G', alter: 1, octave: 4 } },
        { tick: 1680, durationTicks: 480, pitch: { step: 'G', alter: 0, octave: 4 } },
        { tick: 2400, durationTicks: 480, pitch: { step: 'G', alter: 1, octave: 4 } },
        { tick: 4320, durationTicks: 480, pitch: { step: 'G', alter: 0, octave: 4 } },
      ],
      endTick: 4800,
    };

    const ranking = rankCandidates(melody);
    const untransposed = ranking.candidates.find((candidate) => candidate.semitones === 0)!;
    const printed = buildNotation(untransposed.melody).measures
      .flatMap((measure) => measure.elements)
      .flatMap((element) => element.kind === 'note' && element.printedAccidental ? [element.printedAccidental] : []);
    expect(printed).toEqual(['sharp', 'natural', 'sharp']);
    expect(untransposed.tiebreak.accidentals).toBe(printed.length);
  });

  it('applies hardFingerings, accidentals, absShift, and lowest-placement tiebreaks in order', () => {
    // Symmetric single-note melody centered around 67 (G4):
    // Shift -1 -> F♯4 (MIDI 66, |66-67|=1, fingering 2 -> 0 hard, F♯ major? No, G major -> G♭ major (6♭))
    // Shift +1 -> A♭4 (MIDI 68, |68-67|=1, fingering 2+3 -> 1 hard)
    // Shift 0 -> G4 (MIDI 67, centerDistance 0)
    // Compare shift -1 vs +1 when center is 67: both have score 0 and centerDistance 2,
    // so F♯4 (0 hard fingerings) must rank ahead of A♭4 (1 hard fingering).
    const singleG4: Melody = {
      keys: [{ tick: 0, tonic: { step: 'G', alter: 0 }, mode: 'major' }],
      meters: [{ tick: 0, numerator: 4, denominator: 4 }],
      tuplets: [],
      events: [{ tick: 0, durationTicks: 480, pitch: { step: 'G', alter: 0, octave: 4 } }],
      endTick: 480,
    };
    const r1 = rankCandidates(singleG4, DEFAULT_PROFILE);
    expect(r1.best.semitones).toBe(0);
    const idxMinus1 = r1.candidates.findIndex((c) => c.semitones === -1);
    const idxPlus1 = r1.candidates.findIndex((c) => c.semitones === 1);
    expect(idxMinus1).toBeGreaterThan(0);
    expect(idxPlus1).toBeGreaterThan(idxMinus1);
    expect(r1.candidates[idxMinus1]!.tiebreak.hardFingerings).toBe(0);
    expect(r1.candidates[idxPlus1]!.tiebreak.hardFingerings).toBe(1);

    // Shifts ±1 land equally far from the center and tie until the lower-placement rule.
    const tieLowest: Melody = {
      keys: [{ tick: 0, tonic: { step: 'C', alter: 0 }, mode: 'major' }],
      meters: [{ tick: 0, numerator: 4, denominator: 4 }],
      tuplets: [],
      events: [{ tick: 0, durationTicks: 480, pitch: { step: 'F', alter: 0, octave: 4 } }],
      endTick: 480,
    };
    const rLow = rankCandidates(tieLowest, { ...DEFAULT_PROFILE, center: 65 });
    const cNeg1 = rLow.candidates.find((c) => c.semitones === -1)!;
    const cPos1 = rLow.candidates.find((c) => c.semitones === 1)!;
    expect(cNeg1.score).toBe(0);
    expect(cPos1.score).toBe(0);
    expect(cNeg1.tiebreak).toEqual(cPos1.tiebreak);
    expect(rLow.candidates.indexOf(cNeg1)).toBeLessThan(rLow.candidates.indexOf(cPos1));
  });

  it('rejects an octave offset that would require ranking over 100,000 shifts', () => {
    const { voices } = importHookpad(JSON.stringify({
      keys: [{ startTick: 0, tonic: 'C', scale: 'major' }],
      notes: [
        { startTick: 0, durationTicks: 480, sd: '1', octave: 0 },
        { startTick: 480, durationTicks: 480, sd: '1', octave: 10_000 },
      ],
    }));

    expect(() => rankCandidates(voices[0]!.melody)).toThrow(/spans too many octaves/i);
  });

  it('ranks a narrow melody even when all notes start far from the trumpet register', () => {
    const { voices } = importHookpad(JSON.stringify({
      keys: [{ startTick: 0, tonic: 'C', scale: 'major' }],
      notes: [{ startTick: 0, durationTicks: 480, sd: '1', octave: 10_000 }],
    }));

    const ranking = rankCandidates(voices[0]!.melody);
    expect(ranking.anyFits).toBe(true);
    expect(ranking.best.fits).toBe(true);
    expect(ranking.candidates).toHaveLength(21);
  });

  it('rejects unsafe octave offsets before incrementing candidate shifts', () => {
    const { voices } = importHookpad(JSON.stringify({
      keys: [{ startTick: 0, tonic: 'C', scale: 'major' }],
      notes: [{ startTick: 0, durationTicks: 480, sd: '1', octave: 1e16 }],
    }));

    expect(() => rankCandidates(voices[0]!.melody)).toThrow(/octave offset too large/i);
  });

  it('handles a rest-only melody gracefully without throwing', () => {
    const restOnly: Melody = {
      keys: [{ tick: 0, tonic: { step: 'C', alter: 0 }, mode: 'major' }],
      meters: [{ tick: 0, numerator: 4, denominator: 4 }],
      tuplets: [],
      events: [{ tick: 0, durationTicks: 480, pitch: null }],
      endTick: 480,
    };
    const ranking = rankCandidates(restOnly, DEFAULT_PROFILE);
    expect(ranking.anyFits).toBe(true);
    expect(ranking.best.semitones).toBe(0);
    expect(ranking.best.score).toBe(0);
    expect(ranking.best.combinedScore).toBe(0);
    expect(ranking.best.outOfRange).toEqual([]);
  });

  it('computes combinedScore with exported weights and attack-weight-weighted average |fifths| across key regions', () => {
    expect(RANKING_WEIGHTS).toEqual({
      demandingFingering: 0.5,
      keyAccidentals: 0.12,
    });

    // Two-key melody:
    // Region 1 (tick 0, C major, |fifths| = 0): G4 quarter (dur 480, weight 2, not demanding, in preferred)
    // Region 2 (tick 480, A♭ major, |fifths| = 4): E♭4 half (dur 960, weight 3, demanding 2+3, in preferred)
    // Total W = 5, Wd = 3, score = 0, weighted keyAccidentals = (2*0 + 3*4)/5 = 2.4
    // combinedScore = 0 + 0.5*(3/5) + 0.12*(2.4) = 0.3 + 0.288 = 0.588
    const twoKey: Melody = {
      keys: [
        { tick: 0, tonic: { step: 'C', alter: 0 }, mode: 'major' },
        { tick: 480, tonic: { step: 'A', alter: -1 }, mode: 'major' },
      ],
      meters: [{ tick: 0, numerator: 4, denominator: 4 }],
      tuplets: [],
      events: [
        { tick: 0, durationTicks: 480, pitch: { step: 'G', alter: 0, octave: 4 } },
        { tick: 480, durationTicks: 960, pitch: { step: 'E', alter: -1, octave: 4 } },
      ],
      endTick: 1440,
    };

    const ranking = rankCandidates(twoKey, DEFAULT_PROFILE);
    const shift0 = ranking.candidates.find((c) => c.semitones === 0)!;
    expect(shift0.score).toBe(0);
    expect(shift0.combinedScore).toBeCloseTo(0.588, 6);
  });

  it('breaks combinedScore ties using score, centerDistance, hardFingerings, accidentals, absShift, and lowest placement', () => {
    // F major (E4, G4) vs G major (F♯4, A4): both have score 0, 0 demanding, 1 key accidental
    // -> combinedScore = 0.12, score = 0, centerDistance = 6, hardFingerings = 0, accidentals = 1.
    // absShift picks shift 0 over shift +2.
    const fMajorPair: Melody = {
      keys: [{ tick: 0, tonic: { step: 'F', alter: 0 }, mode: 'major' }],
      meters: [{ tick: 0, numerator: 4, denominator: 4 }],
      tuplets: [],
      events: [
        { tick: 0, durationTicks: 480, pitch: { step: 'E', alter: 0, octave: 4 } },
        { tick: 480, durationTicks: 480, pitch: { step: 'G', alter: 0, octave: 4 } },
      ],
      endTick: 960,
    };
    const r = rankCandidates(fMajorPair, DEFAULT_PROFILE);
    const s0 = r.candidates.find((c) => c.semitones === 0)!;
    const s2 = r.candidates.find((c) => c.semitones === 2)!;
    expect(s0.combinedScore).toBeCloseTo(0.12, 9);
    expect(s2.combinedScore).toBeCloseTo(0.12, 9);
    expect(s0.tiebreak.centerDistance).toBe(s2.tiebreak.centerDistance);
    expect(r.best.semitones).toBe(0);
    expect(r.candidates.indexOf(s0)).toBeLessThan(r.candidates.indexOf(s2));
  });
});
