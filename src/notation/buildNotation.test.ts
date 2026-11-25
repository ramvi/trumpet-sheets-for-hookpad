import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fingeringLabel } from '../fingering';
import { importHookpad } from '../import';
import {
  lowFiveNote,
  referenceMelody,
  tieAndTriplet,
  wideMelody,
  withKeyChange,
  withRestsAndGap,
} from '../../tests/melodies';
import { TPQ, type Melody } from '../model/types';
import { rankCandidates, toWrittenBase } from '../transpose';
import { buildNotation } from './index';
import type { NotatedNote } from './types';

function allNotes(score: ReturnType<typeof buildNotation>): NotatedNote[] {
  return score.measures.flatMap((m) =>
    m.elements.filter((el): el is NotatedNote => el.kind === 'note'),
  );
}

describe('buildNotation — referenceMelody', () => {
  const score = buildNotation(referenceMelody, {
    title: 'Reference',
    fingeringLabel,
  });

  it('produces exact expected statistics', () => {
    expect(score.stats).toEqual({
      measures: 9,
      onsets: 36,
      noteheads: 40,
      tupletGroups: 3,
      ties: 4,
      fingeringLabels: 15,
    });
  });

  const notesInBar = (bar: number) =>
    score.measures[bar - 1]!.elements.filter((e): e is NotatedNote => e.kind === 'note');

  it('splits a dotted quarter on beat 2 at beat 3 and beams the tied eighth with the next note', () => {
    const notes = notesInBar(2);
    expect(notes.map((n) => n.writtenTicks)).toEqual([480, 480, 240, 240, 480]);
    expect(notes[1]).toMatchObject({ isOnset: true, tiedToNext: true });
    expect(notes[2]).toMatchObject({ isOnset: false, tiedFromPrev: true, fingering: null, beamGroup: 2 });
    expect(notes[3]).toMatchObject({ fingering: '2+3', beamGroup: 2 });
  });

  it('preserves every attack once with exact pitch, startTick, and total tied sounding duration', () => {
    const notes = allNotes(score);
    const byOnset = new Map<number, NotatedNote[]>();
    for (const n of notes) {
      const list = byOnset.get(n.onsetIndex) ?? [];
      list.push(n);
      byOnset.set(n.onsetIndex, list);
    }

    const expectedEvents = referenceMelody.events.filter((e) => e.pitch !== null);
    expect(byOnset.size).toBe(expectedEvents.length);

    for (let i = 0; i < expectedEvents.length; i++) {
      const ev = expectedEvents[i]!;
      const pieces = byOnset.get(i)!;
      expect(pieces).toBeDefined();
      expect(pieces[0]!.isOnset).toBe(true);
      expect(pieces[0]!.startTick).toBe(ev.tick);
      expect(pieces[0]!.pitch).toEqual(ev.pitch);

      for (let p = 1; p < pieces.length; p++) {
        expect(pieces[p]!.isOnset).toBe(false);
        expect(pieces[p]!.tiedFromPrev).toBe(true);
        expect(pieces[p]!.fingering).toBeNull();
        expect(pieces[p]!.pitch).toEqual(ev.pitch);
      }
      for (let p = 0; p < pieces.length - 1; p++) {
        expect(pieces[p]!.tiedToNext).toBe(true);
      }
      expect(pieces[pieces.length - 1]!.tiedToNext).toBe(false);

      const totalSounding = pieces.reduce((sum, x) => sum + x.soundingTicks, 0);
      expect(Math.round(totalSounding)).toBe(ev.durationTicks);
    }
  });

  it('engraves eighth triplets, a held note tied into a triplet, and quarter triplets', () => {
    const bar3 = notesInBar(3);
    expect(bar3.map((n) => n.writtenTicks)).toEqual([240, 240, 240, 480, 720, 240]);
    expect(bar3[0]!.tuplet).toMatchObject({ isStart: true, itemCount: 3 });

    const bar4 = notesInBar(4);
    expect(bar4.map((n) => n.writtenTicks)).toEqual([960, 480, 240, 240, 240]);
    expect(bar4[0]).toMatchObject({ tiedToNext: true, tuplet: null });
    expect(bar4[1]).toMatchObject({ tiedFromPrev: true, fingering: null });
    expect(bar4[1]!.tuplet).toMatchObject({ isStart: true, actual: 3, normal: 2, itemCount: 2 });
    expect(bar4[2]!.tuplet?.isEnd).toBe(true);

    expect(notesInBar(5).slice(0, 3).map((n) => n.writtenTicks)).toEqual([480, 480, 480]);
    expect(notesInBar(5)[0]!.tuplet).toMatchObject({ isStart: true, itemCount: 3 });
  });

  it('prints local and courtesy accidentals', () => {
    const printed = score.measures.map((_, i) =>
      notesInBar(i + 1)
        .filter((n) => n.printedAccidental)
        .map((n) => `${n.pitch.step}${n.pitch.octave}:${n.printedAccidental}`),
    );
    expect(printed).toEqual([
      [], [], [], [],
      ['C5:flat'],
      ['C5:natural'], // courtesy after C♭5 in the previous bar
      ['A4:natural'],
      ['B4:natural'],
      [], // tied over the bar line: not repeated
    ]);
    expect(notesInBar(6)[0]!.fingering).toBeNull();
    expect(score.abc).toContain('_c2'); // C♭5 stays spelled as C♭, not B
    expect(score.abc).toContain('K:Eb');
  });

  it('spreads bars evenly over systems', () => {
    expect(score.systems.map((s) => s.measures.length)).toEqual([3, 3, 3]);
  });
});

describe('buildNotation — accidental rules edge cases', () => {
  it('prints an accidental once for repeated altered notes in the same bar, and tracks octaves independently', () => {
    const mel: Melody = {
      keys: [{ tick: 0, tonic: { step: 'C', alter: 0 }, mode: 'minor' }],
      meters: [{ tick: 0, numerator: 4, denominator: 4 }],
      tuplets: [],
      events: [
        // Bar 1: E♮4, E♮4 (no repeat!), E♭5 (different octave -> matches key sig -> no acc), E♮5 (needs natural!)
        { tick: 0, durationTicks: TPQ, pitch: { step: 'E', alter: 0, octave: 4 } },
        { tick: TPQ, durationTicks: TPQ, pitch: { step: 'E', alter: 0, octave: 4 } },
        { tick: TPQ * 2, durationTicks: TPQ, pitch: { step: 'E', alter: -1, octave: 5 } },
        { tick: TPQ * 3, durationTicks: TPQ, pitch: { step: 'E', alter: 0, octave: 5 } },
        // Bar 2: E♮4 again (barline reset -> needs natural!), then E♭4 (cancels natural -> needs flat!)
        { tick: TPQ * 4, durationTicks: TPQ * 2, pitch: { step: 'E', alter: 0, octave: 4 } },
        { tick: TPQ * 6, durationTicks: TPQ * 2, pitch: { step: 'E', alter: -1, octave: 4 } },
      ],
      endTick: TPQ * 8,
    };

    const score = buildNotation(mel);
    const b1 = score.measures[0]!.elements as NotatedNote[];
    expect(b1.map((n) => n.printedAccidental)).toEqual(['natural', null, null, 'natural']);

    const b2 = score.measures[1]!.elements as NotatedNote[];
    expect(b2.map((n) => n.printedAccidental)).toEqual(['natural', 'flat']);
  });

  it('does not repeat accidental on a note tied across a barline', () => {
    const mel: Melody = {
      keys: [{ tick: 0, tonic: { step: 'C', alter: 0 }, mode: 'major' }],
      meters: [{ tick: 0, numerator: 4, denominator: 4 }],
      tuplets: [],
      events: [
        { tick: 0, durationTicks: TPQ * 2, pitch: { step: 'C', alter: 0, octave: 4 } },
        { tick: TPQ * 2, durationTicks: TPQ * 4, pitch: { step: 'F', alter: 1, octave: 4 } },
        { tick: TPQ * 6, durationTicks: TPQ * 2, pitch: { step: 'F', alter: 1, octave: 4 } },
      ],
      endTick: TPQ * 8,
    };

    const score = buildNotation(mel);
    const b1 = score.measures[0]!.elements as NotatedNote[];
    const b2 = score.measures[1]!.elements as NotatedNote[];

    expect(b1[1]!.printedAccidental).toBe('sharp');
    expect(b1[1]!.tiedToNext).toBe(true);
    // Tied continuation across barline must NOT repeat sharp
    expect(b2[0]!.tiedFromPrev).toBe(true);
    expect(b2[0]!.printedAccidental).toBeNull();
    // Re-attacked F♯4 later in bar 2 DOES print sharp
    expect(b2[1]!.printedAccidental).toBe('sharp');
  });
});

describe('buildNotation — synthetic fixtures', () => {
  it('handles explicit rest, implicit gap, and final-bar padding in withRestsAndGap', () => {
    const score = buildNotation(withRestsAndGap, { fingeringLabel });
    expect(score.stats).toEqual({
      measures: 2,
      onsets: 4,
      noteheads: 4,
      tupletGroups: 0,
      ties: 0,
      fingeringLabels: 0,
    });

    const b1Kinds = score.measures[0]!.elements.map((e) => `${e.kind}:${e.writtenTicks}`);
    expect(b1Kinds).toEqual(['note:480', 'rest:480', 'note:480', 'rest:480']);

    const b2Kinds = score.measures[1]!.elements.map((e) => `${e.kind}:${e.writtenTicks}`);
    expect(b2Kinds).toEqual(['note:480', 'note:480', 'rest:960']);
  });

  it('handles mid-melody key change in withKeyChange', () => {
    const score = buildNotation(withKeyChange, { fingeringLabel });
    expect(score.stats.measures).toBe(4);
    expect(score.measures[0]!.keyFifths).toBe(0);
    expect(score.measures[0]!.hasKeyChange).toBe(false);
    expect(score.measures[2]!.keyFifths).toBe(-4);
    expect(score.measures[2]!.hasKeyChange).toBe(true);

    // No local flats needed in bars 3–4 because Ab, Bb, Db, Eb are in the Ab major key signature
    const bar3And4Accs = [...score.measures[2]!.elements, ...score.measures[3]!.elements]
      .filter((e): e is NotatedNote => e.kind === 'note')
      .map((n) => n.printedAccidental);
    expect(bar3And4Accs.every((a) => a === null)).toBe(true);
    expect(score.abc).toContain('[K:Ab]');
  });

  it('handles bar-crossing tie + triplet in tieAndTriplet', () => {
    const score = buildNotation(tieAndTriplet, { fingeringLabel });
    expect(score.stats).toEqual({
      measures: 2,
      onsets: 6,
      noteheads: 7,
      tupletGroups: 1,
      ties: 1,
      fingeringLabels: 0,
    });

    const b1 = score.measures[0]!.elements as NotatedNote[];
    const b2 = score.measures[1]!.elements as NotatedNote[];
    expect(b1.map((n) => n.writtenTicks)).toEqual([960, 960]);
    expect(b1[1]!.tiedToNext).toBe(true);
    expect(b2[0]!.writtenTicks).toBe(480);
    expect(b2[0]!.tiedFromPrev).toBe(true);
    expect(b2[1]!.tuplet?.isStart).toBe(true);
    expect(b2[3]!.tuplet?.isEnd).toBe(true);
  });

  it('handles lowFiveNote and wideMelody with full-bar padding', () => {
    const low = buildNotation(lowFiveNote, { fingeringLabel });
    expect(low.stats).toEqual({
      measures: 2,
      onsets: 5,
      noteheads: 5,
      tupletGroups: 0,
      ties: 0,
      fingeringLabels: 3, // G3, A3, B3
    });
    // Bar 2: D4 quarter + beat 2 quarter rest + beats 3-4 half rest
    expect(low.measures[1]!.elements.map((e) => `${e.kind}:${e.writtenTicks}`)).toEqual([
      'note:480',
      'rest:480',
      'rest:960',
    ]);

    const wide = buildNotation(wideMelody, { fingeringLabel });
    expect(wide.stats).toEqual({
      measures: 2,
      onsets: 6,
      noteheads: 6,
      tupletGroups: 0,
      ties: 0,
      fingeringLabels: 3, // F#3, G3, E5
    });
    // F#3 matches G major key sig (1 sharp), so no local sharp printed
    expect((wide.measures[0]!.elements[0] as NotatedNote).printedAccidental).toBeNull();
  });
});

describe('buildNotation — 4/4 beat-3 split rule', () => {
  it('keeps a half note on beat 2, dotted half, and whole note as single values', () => {
    const mel: Melody = {
      keys: [{ tick: 0, tonic: { step: 'C', alter: 0 }, mode: 'major' }],
      meters: [{ tick: 0, numerator: 4, denominator: 4 }],
      tuplets: [],
      events: [
        // Bar 1: quarter + half on beat 2 + quarter
        { tick: 0, durationTicks: 480, pitch: { step: 'C', alter: 0, octave: 4 } },
        { tick: 480, durationTicks: 960, pitch: { step: 'D', alter: 0, octave: 4 } },
        { tick: 1440, durationTicks: 480, pitch: { step: 'E', alter: 0, octave: 4 } },
        // Bar 2: dotted half + quarter
        { tick: 1920, durationTicks: 1440, pitch: { step: 'F', alter: 0, octave: 4 } },
        { tick: 3360, durationTicks: 480, pitch: { step: 'G', alter: 0, octave: 4 } },
        // Bar 3: whole note
        { tick: 3840, durationTicks: 1920, pitch: { step: 'A', alter: 0, octave: 4 } },
      ],
      endTick: 5760,
    };

    const score = buildNotation(mel);
    expect(score.stats.ties).toBe(0);
    expect(score.measures[0]!.elements.map((e) => e.writtenTicks)).toEqual([480, 960, 480]);
    expect(score.measures[1]!.elements.map((e) => e.writtenTicks)).toEqual([1440, 480]);
    expect(score.measures[2]!.elements.map((e) => e.writtenTicks)).toEqual([1920]);
  });

  it('splits a dotted quarter on beat 2 and a rest crossing beat 3 in 4/4', () => {
    const mel: Melody = {
      keys: [{ tick: 0, tonic: { step: 'C', alter: 0 }, mode: 'major' }],
      meters: [{ tick: 0, numerator: 4, denominator: 4 }],
      tuplets: [],
      events: [
        // Bar 1: quarter, dotted quarter on beat 2 (480..1200 -> 480+240), eighth, quarter
        { tick: 0, durationTicks: 480, pitch: { step: 'C', alter: 0, octave: 4 } },
        { tick: 480, durationTicks: 720, pitch: { step: 'G', alter: 0, octave: 3 } },
        { tick: 1200, durationTicks: 240, pitch: { step: 'C', alter: 0, octave: 4 } },
        { tick: 1440, durationTicks: 480, pitch: { step: 'D', alter: 0, octave: 4 } },
        // Bar 2: quarter, explicit dotted-quarter rest crossing beat 3 (480..1200 -> 480+240), eighth, quarter
        { tick: 1920, durationTicks: 480, pitch: { step: 'E', alter: 0, octave: 4 } },
        { tick: 2400, durationTicks: 720, pitch: null },
        { tick: 3120, durationTicks: 240, pitch: { step: 'F', alter: 0, octave: 4 } },
        { tick: 3360, durationTicks: 480, pitch: { step: 'G', alter: 0, octave: 4 } },
        // Bar 3: quarter, half rest crossing beat 3 (480..1440 -> 480+480), quarter
        { tick: 3840, durationTicks: 480, pitch: { step: 'C', alter: 0, octave: 4 } },
        { tick: 4320, durationTicks: 960, pitch: null },
        { tick: 5280, durationTicks: 480, pitch: { step: 'D', alter: 0, octave: 4 } },
      ],
      endTick: 5760,
    };

    const score = buildNotation(mel, { fingeringLabel });
    expect(score.stats.ties).toBe(1);
    expect(score.measures[0]!.elements.map((e) => `${e.kind}:${e.writtenTicks}`)).toEqual([
      'note:480',
      'note:480',
      'note:240',
      'note:240',
      'note:480',
    ]);
    const b1Notes = score.measures[0]!.elements as NotatedNote[];
    expect(b1Notes[1]!.tiedToNext).toBe(true);
    expect(b1Notes[1]!.fingering).toBe('1+3');
    expect(b1Notes[2]!.tiedFromPrev).toBe(true);
    expect(b1Notes[2]!.fingering).toBeNull();

    expect(score.measures[1]!.elements.map((e) => `${e.kind}:${e.writtenTicks}`)).toEqual([
      'note:480',
      'rest:480',
      'rest:240',
      'note:240',
      'note:480',
    ]);
    expect(score.measures[2]!.elements.map((e) => `${e.kind}:${e.writtenTicks}`)).toEqual([
      'note:480',
      'rest:480',
      'rest:480',
      'note:480',
    ]);
  });

  it('keeps existing behavior in 3/4 (does not apply the 4/4 mid-bar split)', () => {
    const mel34: Melody = {
      keys: [{ tick: 0, tonic: { step: 'C', alter: 0 }, mode: 'major' }],
      meters: [{ tick: 0, numerator: 3, denominator: 4 }],
      tuplets: [],
      events: [
        { tick: 0, durationTicks: 480, pitch: { step: 'C', alter: 0, octave: 4 } },
        { tick: 480, durationTicks: 720, pitch: { step: 'D', alter: 0, octave: 4 } },
        { tick: 1200, durationTicks: 240, pitch: { step: 'E', alter: 0, octave: 4 } },
      ],
      endTick: 1440,
    };

    const score = buildNotation(mel34);
    expect(score.stats.ties).toBe(0);
    expect(score.measures[0]!.elements.map((e) => e.writtenTicks)).toEqual([480, 720, 240]);
  });
});

describe('buildNotation — compound meter and uneven tuplets', () => {
  const C4 = { step: 'C', alter: 0, octave: 4 } as const;
  const base: Melody = { ...withRestsAndGap, tuplets: [], events: [], endTick: 0 };

  it('keeps notes and rests inside the dotted-quarter beats of 6/8', () => {
    const score = buildNotation({
      ...base,
      meters: [{ tick: 0, numerator: 6, denominator: 8 }],
      events: [
        ...[0, 480, 960].map((tick) => ({ tick, durationTicks: 480, pitch: C4 })),
        { tick: 1440, durationTicks: 960, pitch: C4 },
        { tick: 4320, durationTicks: 1440, pitch: C4 },
      ],
      endTick: 5760,
    });
    expect(score.measures.map((m) => m.elements.map((e) => `${e.kind}:${e.writtenTicks}`))).toEqual([
      ['note:480', 'note:240', 'note:240', 'note:480'],
      ['note:720', 'note:240', 'rest:480'],
      ['rest:720', 'rest:720'],
      ['note:1440'],
    ]);
  });

  it.each([
    [7, 4, 120],
    [9, 8, 60],
  ])('engraves a %i-tuplet whose ticks Hookpad rounded', (actual, normal, written) => {
    const starts = Array.from({ length: actual + 1 }, (_, i) => Math.round((i * 480) / actual));
    const score = buildNotation({
      ...base,
      tuplets: [{ startTick: 0, spanTicks: 480, actual, normal }],
      events: starts.slice(0, -1).map((tick, i) => ({ tick, durationTicks: starts[i + 1]! - tick, pitch: C4 })),
      endTick: 480,
    });
    const notes = allNotes(score);
    expect(notes).toHaveLength(actual);
    expect(new Set(notes.map((n) => n.writtenTicks))).toEqual(new Set([written]));
  });
});

describe('buildNotation — courtesy accidentals', () => {
  it('repeats altered accidental in next bar, prints courtesy in bar after, and does not print courtesy two bars later', () => {
    const mel: Melody = {
      keys: [{ tick: 0, tonic: { step: 'C', alter: 0 }, mode: 'major' }],
      meters: [{ tick: 0, numerator: 4, denominator: 4 }],
      tuplets: [],
      events: [
        // Bar 1: F♯4 -> prints sharp
        { tick: 0, durationTicks: 1920, pitch: { step: 'F', alter: 1, octave: 4 } },
        // Bar 2: F♯4 repeated in next bar -> still prints sharp (accidentals do not carry over barlines)
        { tick: 1920, durationTicks: 1920, pitch: { step: 'F', alter: 1, octave: 4 } },
        // Bar 3: F♮4 -> courtesy natural; second F♮4 in same bar -> null
        { tick: 3840, durationTicks: 960, pitch: { step: 'F', alter: 0, octave: 4 } },
        { tick: 4800, durationTicks: 960, pitch: { step: 'F', alter: 0, octave: 4 } },
        // Bar 4: F♮4 -> no courtesy (bar 3 already matched key sig)
        { tick: 5760, durationTicks: 1920, pitch: { step: 'F', alter: 0, octave: 4 } },
        // Bar 5: G♯4 -> prints sharp
        { tick: 7680, durationTicks: 1920, pitch: { step: 'G', alter: 1, octave: 4 } },
        // Bar 6: C4 (no G4 in bar 6)
        { tick: 9600, durationTicks: 1920, pitch: { step: 'C', alter: 0, octave: 4 } },
        // Bar 7: G♮4 (two bars after G♯4) -> NO courtesy accidental
        { tick: 11520, durationTicks: 1920, pitch: { step: 'G', alter: 0, octave: 4 } },
      ],
      endTick: 13440,
    };

    const score = buildNotation(mel);
    const acc = (barIdx: number) =>
      score.measures[barIdx]!.elements
        .filter((e): e is NotatedNote => e.kind === 'note')
        .map((n) => n.printedAccidental);

    expect(acc(0)).toEqual(['sharp']);
    expect(acc(1)).toEqual(['sharp']);
    expect(acc(2)).toEqual(['natural', null]);
    expect(acc(3)).toEqual([null]);
    expect(acc(4)).toEqual(['sharp']);
    expect(acc(5)).toEqual([null]);
    expect(acc(6)).toEqual([null]);
  });

  it('never prints a courtesy accidental on a note tied over the bar line, but prints it on a subsequent natural re-attack', () => {
    const mel: Melody = {
      keys: [{ tick: 0, tonic: { step: 'C', alter: 0 }, mode: 'major' }],
      meters: [{ tick: 0, numerator: 4, denominator: 4 }],
      tuplets: [],
      events: [
        { tick: 0, durationTicks: 960, pitch: { step: 'C', alter: 0, octave: 4 } },
        { tick: 960, durationTicks: 1920, pitch: { step: 'F', alter: 1, octave: 4 } }, // tied across barline
        { tick: 2880, durationTicks: 960, pitch: { step: 'F', alter: 0, octave: 4 } }, // re-attacked natural
      ],
      endTick: 3840,
    };

    const score = buildNotation(mel);
    const b1 = score.measures[0]!.elements as NotatedNote[];
    const b2 = score.measures[1]!.elements as NotatedNote[];
    expect(b1[1]!.printedAccidental).toBe('sharp');
    expect(b2[0]!.tiedFromPrev).toBe(true);
    expect(b2[0]!.printedAccidental).toBeNull();
    expect(b2[1]!.printedAccidental).toBe('natural');
  });
});

describe('buildNotation — fingeringRepeat first-in-run', () => {
  it('re-labels after a different pitch, after explicit rest or gap, at system start, and treats enharmonics as the same pitch', () => {
    const mel: Melody = {
      keys: [{ tick: 0, tonic: { step: 'C', alter: 0 }, mode: 'major' }],
      meters: [{ tick: 0, numerator: 4, denominator: 4 }],
      tuplets: [],
      events: [
        // Bar 1: run of F♯4, F♯4 (drop), G♭4 (enharmonic same MIDI -> drop!), G4 (unlabeled), F♯4 (re-label!)
        { tick: 0, durationTicks: 240, pitch: { step: 'F', alter: 1, octave: 4 } },
        { tick: 240, durationTicks: 240, pitch: { step: 'F', alter: 1, octave: 4 } },
        { tick: 480, durationTicks: 480, pitch: { step: 'G', alter: -1, octave: 4 } },
        { tick: 960, durationTicks: 480, pitch: { step: 'G', alter: 0, octave: 4 } },
        { tick: 1440, durationTicks: 480, pitch: { step: 'F', alter: 1, octave: 4 } },
        // Bar 2: same F♯4 across barline (same system -> drop!), explicit rest, F♯4 (re-label!), implicit gap, F♯4 (re-label!)
        { tick: 1920, durationTicks: 480, pitch: { step: 'F', alter: 1, octave: 4 } },
        { tick: 2400, durationTicks: 240, pitch: null },
        { tick: 2640, durationTicks: 240, pitch: { step: 'F', alter: 1, octave: 4 } },
        // Implicit 480-tick gap at 2880..3360
        { tick: 3360, durationTicks: 480, pitch: { step: 'F', alter: 1, octave: 4 } },
      ],
      endTick: 3840,
    };

    const score = buildNotation(mel, {
      fingeringLabel,
      fingeringRepeat: 'first-in-run',
    });
    expect(score.systems).toHaveLength(1);
    const b1 = score.measures[0]!.elements
      .filter((e): e is NotatedNote => e.kind === 'note')
      .map((n) => n.fingering);
    const b2 = score.measures[1]!.elements
      .filter((e): e is NotatedNote => e.kind === 'note')
      .map((n) => n.fingering);

    expect(b1).toEqual(['2', null, null, null, '2']);
    expect(b2).toEqual([null, '2', '2']);
    expect(score.stats.fingeringLabels).toBe(4);
  });

  it('labels the first attack of a new system even when continuing a repeated-note run from the previous system', () => {
    // 6 bars of continuous repeated E♭4 quarter notes -> forces >= 2 systems (MAX_BARS_PER_SYSTEM = 4)
    const events = [];
    for (let i = 0; i < 24; i++) {
      events.push({
        tick: i * 480,
        durationTicks: 480,
        pitch: { step: 'E' as const, alter: -1, octave: 4 },
      });
    }
    const mel: Melody = {
      keys: [{ tick: 0, tonic: { step: 'E', alter: -1 }, mode: 'major' }],
      meters: [{ tick: 0, numerator: 4, denominator: 4 }],
      tuplets: [],
      events,
      endTick: 24 * 480,
    };

    const score = buildNotation(mel, {
      fingeringLabel,
      fingeringRepeat: 'first-in-run',
    });

    expect(score.systems.length).toBeGreaterThanOrEqual(2);
    // Every system starts with '2+3' and has exactly 1 label
    for (const sys of score.systems) {
      const sysNotes = sys.measures.flatMap((m) =>
        m.elements.filter((e): e is NotatedNote => e.kind === 'note'),
      );
      expect(sysNotes[0]!.fingering).toBe('2+3');
      expect(sysNotes.slice(1).every((n) => n.fingering === null)).toBe(true);
      expect(sys.hasFingerings).toBe(true);
    }
    expect(score.stats.fingeringLabels).toBe(score.systems.length);
  });
});

describe('buildNotation — even system layout', () => {
  it('lays out a dense first half and a sparse second half without single-bar systems', () => {
    const text = readFileSync(
      new URL('../../tests/fixtures/two-parts.txt', import.meta.url),
      'utf8',
    );
    const rk = rankCandidates(toWrittenBase(importHookpad(text).voices[0]!.melody, 'concert'));
    const gMinor = rk.candidates.find((c) => c.semitones === -6)!.melody;
    const gSharpMinor = rk.candidates.find((c) => c.semitones === -5)!.melody;

    for (const mel of [gMinor, gSharpMinor]) {
      for (const mode of ['every', 'first-in-run'] as const) {
        const s = buildNotation(mel, { fingeringLabel, fingeringRepeat: mode });
        const dist = s.systems.map((sys) => sys.measures.length);
        expect(dist).toEqual([2, 2, 2, 2, 4, 4]);
        expect(dist.every((count) => count >= 2)).toBe(true);
      }
    }
  });
});
