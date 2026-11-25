import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { referenceMelody } from '../../tests/melodies';
import { describe, expect, it } from 'vitest';
import { pitchToMidi, transposePitch } from '../model/pitch';
import { TPQ, type Pitch } from '../model/types';
import { ImportError, importHookpad } from './index';
import { resolveScaleDegreePitch } from './pitch';

const FIXTURES_DIR = resolve(process.cwd(), 'tests/fixtures');

const hookpadReferenceText = readFileSync(resolve(FIXTURES_DIR, 'reference-written.json'), 'utf8');
const hookpadBbConcertText = readFileSync(resolve(FIXTURES_DIR, 'reference-concert.json'), 'utf8');

function expectImportError(input: string, expectedCode: ImportError['code']): ImportError {
  try {
    importHookpad(input);
    throw new Error(`Expected ImportError(${expectedCode}), but importHookpad succeeded`);
  } catch (err) {
    expect(err).toBeInstanceOf(ImportError);
    const importErr = err as ImportError;
    expect(importErr.code).toBe(expectedCode);
    expect(importErr.message.length).toBeGreaterThan(10);
    return importErr;
  }
}

describe('importHookpad — reference clips', () => {
  it('imports reference-written.json via the modern path', () => {
    const result = importHookpad(hookpadReferenceText);

    expect(result.warnings).toEqual([]);
    expect(result.voices).toHaveLength(1);

    const voice = result.voices[0]!;
    expect(voice.id).toBe('1');
    expect(voice.label).toBe('Voice 1');
    expect(voice.onsets).toBe(36);
    expect(voice.melody).toEqual(referenceMelody);
  });

  it('accepts surrounding whitespace, BOM, bare modern object, and bare modern payload', () => {
    const raw = JSON.parse(hookpadReferenceText) as {
      modern: { version: string; payload: Record<string, unknown> };
    };

    const withWhitespace = importHookpad(`\uFEFF  \n\t${hookpadReferenceText}\n  `);
    expect(withWhitespace.voices[0]!.melody).toEqual(referenceMelody);

    const bareModern = importHookpad(JSON.stringify(raw.modern));
    expect(bareModern.voices[0]!.melody).toEqual(referenceMelody);

    const barePayload = importHookpad(JSON.stringify(raw.modern.payload));
    expect(barePayload.voices[0]!.melody).toEqual(referenceMelody);
  });

  it('imports reference clip with modern removed via legacy path and matches reference Melody', () => {
    const raw = JSON.parse(hookpadReferenceText) as Record<string, unknown>;
    const legacyOnly = { notes: raw['notes'], keys: raw['keys'] };

    const result = importHookpad(JSON.stringify(legacyOnly));
    expect(result.warnings).toEqual([]);
    expect(result.voices).toHaveLength(1);

    const voice = result.voices[0]!;
    expect(voice.id).toBe('1');
    expect(voice.label).toBe('Voice 1');
    expect(voice.onsets).toBe(36);
    expect(voice.melody.tuplets).toEqual(referenceMelody.tuplets);
    expect(voice.melody).toEqual(referenceMelody);
  });

  it('falls back to legacy when modern is missing or unusable', () => {
    const raw = JSON.parse(hookpadReferenceText) as Record<string, unknown>;
    const brokenModern = { ...raw, modern: { version: 'hooktheory-clipboard-v1', payload: null } };

    const result = importHookpad(JSON.stringify(brokenModern));
    expect(result.voices[0]!.melody).toEqual(referenceMelody);
  });

  it('imports reference-concert.json in Bb minor and matches reference shifted down by 2 semitones & 1 letter', () => {
    const result = importHookpad(hookpadBbConcertText);

    expect(result.warnings).toEqual([]);
    expect(result.voices).toHaveLength(1);

    const voice = result.voices[0]!;
    expect(voice.onsets).toBe(36);

    const { melody } = voice;
    expect(melody.keys).toEqual([{ tick: 0, tonic: { step: 'B', alter: -1 }, mode: 'minor' }]);
    expect(melody.meters).toEqual(referenceMelody.meters);
    expect(melody.tuplets).toEqual(referenceMelody.tuplets);
    expect(melody.endTick).toBe(referenceMelody.endTick);

    expect(melody.events[0]!.pitch).toEqual({ step: 'F', alter: 0, octave: 3 });

    const midis = melody.events
      .map((ev) => ev.pitch)
      .filter((p): p is Pitch => p !== null)
      .map(pitchToMidi);
    expect(Math.min(...midis)).toBe(53); // F3
    expect(Math.max(...midis)).toBe(73); // Db5

    expect(melody.events).toHaveLength(referenceMelody.events.length);
    for (let i = 0; i < melody.events.length; i += 1) {
      const ev = melody.events[i]!;
      const refEv = referenceMelody.events[i]!;
      expect(ev.tick).toBe(refEv.tick);
      expect(ev.durationTicks).toBe(refEv.durationTicks);
      expect(ev.pitch).toEqual(refEv.pitch && transposePitch(refEv.pitch, -1, -2));
    }

    // Legacy fallback of Bb concert clip matches too.
    const raw = JSON.parse(hookpadBbConcertText) as Record<string, unknown>;
    const legacyRes = importHookpad(JSON.stringify({ notes: raw['notes'], keys: raw['keys'] }));
    expect(legacyRes.voices[0]!.melody).toEqual(melody);
  });
});

describe('pitch resolution from scale degrees', () => {
  it('resolves every documented C minor pitch example', () => {
    const cMinor = { tonic: { step: 'C' as const, alter: 0 }, mode: 'minor' as const };
    const cases: Array<[string, number, Pitch, number]> = [
      ['1', 0, { step: 'C', alter: 0, octave: 4 }, 60],
      ['3', 0, { step: 'E', alter: -1, octave: 4 }, 63],
      ['#3', 0, { step: 'E', alter: 0, octave: 4 }, 64],
      ['b5', 0, { step: 'G', alter: -1, octave: 4 }, 66],
      ['#4', 0, { step: 'F', alter: 1, octave: 4 }, 66],
      ['#6', 0, { step: 'A', alter: 0, octave: 4 }, 69],
      ['#7', 0, { step: 'B', alter: 0, octave: 4 }, 71],
      ['5', -1, { step: 'G', alter: 0, octave: 3 }, 55],
      ['3', 1, { step: 'E', alter: -1, octave: 5 }, 75],
      ['b1', 1, { step: 'C', alter: -1, octave: 5 }, 71],
    ];

    for (const [sd, oct, expectedPitch, expectedMidi] of cases) {
      const actual = resolveScaleDegreePitch(sd, oct, cMinor);
      expect(actual, `C minor sd="${sd}" oct=${oct}`).toEqual(expectedPitch);
      expect(pitchToMidi(actual), `MIDI for C minor sd="${sd}" oct=${oct}`).toBe(expectedMidi);
    }
  });

  it('resolves every documented Bb minor pitch example', () => {
    const bbMinor = { tonic: { step: 'B' as const, alter: -1 }, mode: 'minor' as const };
    const cases: Array<[string, number, Pitch, number]> = [
      ['1', 0, { step: 'B', alter: -1, octave: 3 }, 58],
      ['5', -1, { step: 'F', alter: 0, octave: 3 }, 53],
      ['3', 1, { step: 'D', alter: -1, octave: 5 }, 73],
      ['2', 0, { step: 'C', alter: 0, octave: 4 }, 60],
    ];

    for (const [sd, oct, expectedPitch, expectedMidi] of cases) {
      const actual = resolveScaleDegreePitch(sd, oct, bbMinor);
      expect(actual, `Bb minor sd="${sd}" oct=${oct}`).toEqual(expectedPitch);
      expect(pitchToMidi(actual), `MIDI for Bb minor sd="${sd}" oct=${oct}`).toBe(expectedMidi);
    }
  });

  it('handles double accidentals, Unicode accidentals, lowercase tonics, and scale separators', () => {
    const clip = {
      notes: [
        { startTick: 0, durationTicks: 480, sd: '##4', octave: 0, isRest: false, voice: 1 },
        { startTick: 480, durationTicks: 480, sd: 'bb7', octave: 0, isRest: false, voice: 1 },
        { startTick: 960, durationTicks: 480, sd: '♯3', octave: 0, isRest: false, voice: 1 },
        { startTick: 1440, durationTicks: 480, sd: '♭5', octave: 0, isRest: false, voice: 1 },
      ],
      keys: [{ startTick: 0, scale: 'harmonic minor', tonic: 'c' }],
    };

    const res = importHookpad(JSON.stringify(clip));
    expect(res.voices[0]!.melody.keys[0]).toEqual({
      tick: 0,
      tonic: { step: 'C', alter: 0 },
      mode: 'harmonicMinor',
    });
    const pitches = res.voices[0]!.melody.events.map((e) => e.pitch);
    // In C harmonic minor: 4 = F (alter 0) -> ##4 = F𝄪4 (alter 2)
    expect(pitches[0]).toEqual({ step: 'F', alter: 2, octave: 4 });
    // In C harmonic minor: 7 = B♮ (alter 0) -> bb7 = B𝄫4 (alter -2)
    expect(pitches[1]).toEqual({ step: 'B', alter: -2, octave: 4 });
    // In C harmonic minor: 3 = Eb -> #3 = E♮4
    expect(pitches[2]).toEqual({ step: 'E', alter: 0, octave: 4 });
    // In C harmonic minor: 5 = G -> b5 = Gb4
    expect(pitches[3]).toEqual({ step: 'G', alter: -1, octave: 4 });

    // Also test phrygian_dominant with Unicode flat tonic
    const pdClip = {
      notes: [{ beat: 1, duration: 1, sd: '3', octave: 0, isRest: false }],
      keys: [{ beat: 1, scale: 'Phrygian_Dominant', tonic: 'b♭' }],
    };
    const pdRes = importHookpad(JSON.stringify(pdClip));
    expect(pdRes.voices[0]!.melody.keys[0]).toEqual({
      tick: 0,
      tonic: { step: 'B', alter: -1 },
      mode: 'phrygianDominant',
    });
    // Major 3rd above Bb3 = D4
    expect(pdRes.voices[0]!.melody.events[0]!.pitch).toEqual({ step: 'D', alter: 0, octave: 4 });
  });
});

describe('synthetic clips — normalization, voices, keys, meters, tuplets, warnings', () => {
  it('preserves explicit rests and implicit gaps', () => {
    const clip = {
      notes: [
        { id: 'n1', sd: '1', octave: 0, startTick: 0, durationTicks: 480, isRest: false, voice: 1 },
        { id: 'r1', sd: '', octave: 0, startTick: 480, durationTicks: 480, isRest: true, voice: 1 },
        // Implicit gap 960..1440
        { id: 'n2', sd: '5', octave: 0, startTick: 1440, durationTicks: 480, isRest: false, voice: 1 },
      ],
      keys: [{ startTick: 0, scale: 'major', tonic: 'C' }],
      meters: [],
    };

    const res = importHookpad(JSON.stringify(clip));
    expect(res.voices[0]!.onsets).toBe(2);
    expect(res.voices[0]!.melody.events).toEqual([
      { tick: 0, durationTicks: 480, pitch: { step: 'C', alter: 0, octave: 4 } },
      { tick: 480, durationTicks: 480, pitch: null },
      { tick: 1440, durationTicks: 480, pitch: { step: 'G', alter: 0, octave: 4 } },
    ]);
    expect(res.voices[0]!.melody.endTick).toBe(1920);
  });

  it('splits and sorts multiple voices with independent melodies and onset counts', () => {
    const clip = {
      notes: [
        { id: 'v2a', sd: '3', octave: 0, startTick: 0, durationTicks: 480, isRest: false, voice: 2 },
        { id: 'v1a', sd: '1', octave: 0, startTick: 0, durationTicks: 480, isRest: false, voice: 1 },
        { id: 'v2b', sd: '5', octave: 0, startTick: 480, durationTicks: 480, isRest: false, voice: 2 },
        { id: 'v2r', sd: '', octave: 0, startTick: 960, durationTicks: 480, isRest: true, voice: 2 },
      ],
      keys: [{ startTick: 0, scale: 'major', tonic: 'C' }],
      meters: [],
    };

    const res = importHookpad(JSON.stringify(clip));
    expect(res.voices).toHaveLength(2);
    expect(res.voices[0]!.id).toBe('1');
    expect(res.voices[0]!.label).toBe('Voice 1');
    expect(res.voices[0]!.onsets).toBe(1);
    expect(res.voices[0]!.melody.endTick).toBe(480);

    expect(res.voices[1]!.id).toBe('2');
    expect(res.voices[1]!.label).toBe('Voice 2');
    expect(res.voices[1]!.onsets).toBe(2);
    expect(res.voices[1]!.melody.events).toHaveLength(3);
    expect(res.voices[1]!.melody.endTick).toBe(1440);
  });

  it('handles mid-clip key changes and normalizes a first key starting after tick 0', () => {
    const clip = {
      notes: [
        { id: 'n1', sd: '1', octave: 0, startTick: 0, durationTicks: 480, isRest: false, voice: 1 },
        { id: 'n2', sd: '3', octave: 0, startTick: 480, durationTicks: 480, isRest: false, voice: 1 },
        { id: 'n3', sd: '1', octave: 0, startTick: 1920, durationTicks: 480, isRest: false, voice: 1 },
        { id: 'n4', sd: '3', octave: 0, startTick: 2400, durationTicks: 480, isRest: false, voice: 1 },
      ],
      keys: [
        { startTick: 480, scale: 'major', tonic: 'C' }, // starts after tick 0 -> applies from tick 0
        { startTick: 1920, scale: 'major', tonic: 'Ab' },
      ],
    };

    const res = importHookpad(JSON.stringify(clip));
    const { melody } = res.voices[0]!;
    expect(melody.keys).toEqual([
      { tick: 0, tonic: { step: 'C', alter: 0 }, mode: 'major' },
      { tick: 1920, tonic: { step: 'A', alter: -1 }, mode: 'major' },
    ]);
    expect(melody.events.map((e) => e.pitch)).toEqual([
      { step: 'C', alter: 0, octave: 4 },
      { step: 'E', alter: 0, octave: 4 },
      { step: 'A', alter: -1, octave: 3 },
      { step: 'C', alter: 0, octave: 4 },
    ]);
  });

  it('handles major key, sharp keys (F# major & E major), and dorian mode', () => {
    // F# major: F#4, G#4, A#4, B4, C#5, D#5, E#5
    const fSharpMajor = {
      notes: [
        { beat: 1, duration: 1, sd: '1', octave: 0, isRest: false },
        { beat: 2, duration: 1, sd: '3', octave: 0, isRest: false },
        { beat: 3, duration: 1, sd: '7', octave: 0, isRest: false },
      ],
      keys: [{ beat: 1, scale: 'major', tonic: 'F#' }],
    };
    const fsRes = importHookpad(JSON.stringify(fSharpMajor));
    expect(fsRes.voices[0]!.melody.events.map((e) => e.pitch)).toEqual([
      { step: 'F', alter: 1, octave: 4 },
      { step: 'A', alter: 1, octave: 4 },
      { step: 'E', alter: 1, octave: 5 },
    ]);

    // E major: E4, F#4, G#4, A4, B4, C#5, D#5
    const eMajor = {
      notes: [
        { beat: 1, duration: 1, sd: '1', octave: 0, isRest: false },
        { beat: 2, duration: 1, sd: '6', octave: 0, isRest: false },
      ],
      keys: [{ beat: 1, scale: 'major', tonic: 'E' }],
    };
    const eRes = importHookpad(JSON.stringify(eMajor));
    expect(eRes.voices[0]!.melody.events.map((e) => e.pitch)).toEqual([
      { step: 'E', alter: 0, octave: 4 },
      { step: 'C', alter: 1, octave: 5 },
    ]);

    // D dorian: D4, E4, F4, G4, A4, B4, C5
    const dDorian = {
      notes: [
        { beat: 1, duration: 1, sd: '1', octave: 0, isRest: false },
        { beat: 2, duration: 1, sd: '3', octave: 0, isRest: false },
        { beat: 3, duration: 1, sd: '6', octave: 0, isRest: false },
        { beat: 4, duration: 1, sd: '7', octave: 0, isRest: false },
      ],
      keys: [{ beat: 1, scale: 'dorian', tonic: 'D' }],
    };
    const dRes = importHookpad(JSON.stringify(dDorian));
    expect(dRes.voices[0]!.melody.keys[0]!.mode).toBe('dorian');
    expect(dRes.voices[0]!.melody.events.map((e) => e.pitch)).toEqual([
      { step: 'D', alter: 0, octave: 4 },
      { step: 'F', alter: 0, octave: 4 },
      { step: 'B', alter: 0, octave: 4 },
      { step: 'C', alter: 0, octave: 5 },
    ]);
  });

  it('infers sixteenth-note, eighth-note, and quarter-note triplets in legacy clips', () => {
    const legacyTuplets = {
      notes: [
        // Beat 1: sixteenth-note triplet (ticks 0..240) + regular eighth (240..480)
        { beat: 1, duration: 1 / 6, sd: '1', octave: 0, isRest: false },
        { beat: 1 + 1 / 6, duration: 1 / 6, sd: '2', octave: 0, isRest: false },
        { beat: 1 + 2 / 6, duration: 1 / 6, sd: '3', octave: 0, isRest: false },
        { beat: 1.5, duration: 0.5, sd: '4', octave: 0, isRest: false },
        // Beat 2: eighth-note triplet (ticks 480..960)
        { beat: 2, duration: 1 / 3, sd: '5', octave: 0, isRest: false },
        { beat: 2 + 1 / 3, duration: 1 / 3, sd: '4', octave: 0, isRest: false },
        { beat: 2 + 2 / 3, duration: 1 / 3, sd: '3', octave: 0, isRest: false },
        // Beats 3-4: quarter-note triplet (ticks 960..1920)
        { beat: 3, duration: 2 / 3, sd: '2', octave: 0, isRest: false },
        { beat: 3 + 2 / 3, duration: 2 / 3, sd: '3', octave: 0, isRest: false },
        { beat: 3 + 4 / 3, duration: 2 / 3, sd: '1', octave: 0, isRest: false },
      ],
      keys: [{ beat: 1, scale: 'major', tonic: 'C' }],
    };

    const res = importHookpad(JSON.stringify(legacyTuplets));
    expect(res.voices[0]!.melody.tuplets).toEqual([
      { startTick: 0, spanTicks: 240, actual: 3, normal: 2 },
      { startTick: 480, spanTicks: 480, actual: 3, normal: 2 },
      { startTick: 960, spanTicks: 960, actual: 3, normal: 2 },
    ]);
  });

  it('infers quarter-note triplets starting on an odd beat (beat 2) and handles modern quintuplets', () => {
    const oddBeatQuarterTriplet = {
      notes: [
        { beat: 1, duration: 1, sd: '1', octave: 0, isRest: false },
        { beat: 2, duration: 2 / 3, sd: '2', octave: 0, isRest: false },
        { beat: 2 + 2 / 3, duration: 2 / 3, sd: '3', octave: 0, isRest: false },
        { beat: 2 + 4 / 3, duration: 2 / 3, sd: '4', octave: 0, isRest: false },
      ],
      keys: [{ beat: 1, scale: 'major', tonic: 'C' }],
    };
    const res1 = importHookpad(JSON.stringify(oddBeatQuarterTriplet));
    expect(res1.voices[0]!.melody.tuplets).toEqual([
      { startTick: TPQ, spanTicks: TPQ * 2, actual: 3, normal: 2 },
    ]);

    const modernQuintuplet = {
      notes: [0, 1, 2, 3, 4].map((i) => ({
        id: `q${i}`,
        sd: String(i + 1),
        octave: 0,
        startTick: i * 96,
        durationTicks: 96,
        isRest: false,
        voice: 1,
        tuplet: { id: 'tup_q', n: 5, startTick: 0, spanTicks: 480 },
      })),
      keys: [{ startTick: 0, scale: 'major', tonic: 'C' }],
    };
    const res2 = importHookpad(JSON.stringify(modernQuintuplet));
    expect(res2.voices[0]!.melody.tuplets).toEqual([
      { startTick: 0, spanTicks: 480, actual: 5, normal: 4 },
    ]);
  });

  it('subtracts baseTick only when baseTick > 0 and all notes/keys start at or after it', () => {
    const shifted = {
      notes: [
        { startTick: 1920, durationTicks: 480, sd: '1', octave: 0, isRest: false, voice: 1 },
        { startTick: 2400, durationTicks: 480, sd: '2', octave: 0, isRest: false, voice: 1 },
      ],
      keys: [{ startTick: 1920, scale: 'major', tonic: 'C' }],
      baseTick: 1920,
    };
    const resShifted = importHookpad(JSON.stringify(shifted));
    expect(resShifted.voices[0]!.melody.events[0]!.tick).toBe(0);
    expect(resShifted.voices[0]!.melody.events[1]!.tick).toBe(480);

    const notShifted = {
      notes: [
        { startTick: 1920, durationTicks: 480, sd: '1', octave: 0, isRest: false, voice: 1 },
      ],
      keys: [{ startTick: 0, scale: 'major', tonic: 'C' }],
      baseTick: 1920,
    };
    const resNotShifted = importHookpad(JSON.stringify(notShifted));
    expect(resNotShifted.voices[0]!.melody.events[0]!.tick).toBe(1920);
  });

  it('resolves same-tick collisions (keeps highest) and shortens overlapping notes with warnings', () => {
    const clip = {
      notes: [
        // Same tick 0: C4 vs G4 -> keep G4
        { id: 'low', sd: '1', octave: 0, startTick: 0, durationTicks: 480, isRest: false, voice: 1 },
        { id: 'high', sd: '5', octave: 0, startTick: 0, durationTicks: 960, isRest: false, voice: 1 },
        // Overlaps next note at tick 480 -> G4 shortened from 960 to 480
        { id: 'next', sd: '3', octave: 0, startTick: 480, durationTicks: 480, isRest: false, voice: 1 },
      ],
      keys: [{ startTick: 0, scale: 'major', tonic: 'C' }],
    };

    const res = importHookpad(JSON.stringify(clip));
    expect(res.voices[0]!.onsets).toBe(2);
    expect(res.voices[0]!.melody.events).toEqual([
      { tick: 0, durationTicks: 480, pitch: { step: 'G', alter: 0, octave: 4 } },
      { tick: 480, durationTicks: 480, pitch: { step: 'E', alter: 0, octave: 4 } },
    ]);
    expect(res.warnings).toHaveLength(2);
    expect(res.warnings[0]).toMatch(/simultaneous/i);
    expect(res.warnings[1]).toMatch(/overlapped/i);
  });
});

describe('importHookpad — error codes', () => {
  it('throws invalid-json for empty or non-JSON text', () => {
    expectImportError('', 'invalid-json');
    expectImportError('   \n\t  ', 'invalid-json');
    expectImportError('not json at all', 'invalid-json');
    expectImportError('{broken json', 'invalid-json');
  });

  it('throws not-hookpad for valid JSON that is not a Hookpad clip', () => {
    expectImportError('{}', 'not-hookpad');
    expectImportError('[]', 'not-hookpad');
    expectImportError('"hello"', 'not-hookpad');
    expectImportError('42', 'not-hookpad');
    expectImportError('null', 'not-hookpad');
    expectImportError(JSON.stringify({ notes: ['buy milk', 'walk dog'] }), 'not-hookpad');
    expectImportError(JSON.stringify({ notes: [{ title: 'not a note' }] }), 'not-hookpad');
  });

  it('throws missing-key when keys are absent, empty, or missing tonic', () => {
    expectImportError(
      JSON.stringify({ notes: [{ beat: 1, duration: 1, sd: '1', octave: 0 }] }),
      'missing-key',
    );
    expectImportError(
      JSON.stringify({ notes: [{ beat: 1, duration: 1, sd: '1', octave: 0 }], keys: [] }),
      'missing-key',
    );
    expectImportError(
      JSON.stringify({
        notes: [{ startTick: 0, durationTicks: 480, sd: '1', octave: 0 }],
        keys: [{ startTick: 0, scale: 'major' }],
      }),
      'missing-key',
    );
    expectImportError(
      JSON.stringify({
        notes: [{ startTick: 0, durationTicks: 480, sd: '1', octave: 0 }],
        keys: [{ startTick: 0, scale: 'major', tonic: '  ' }],
      }),
      'missing-key',
    );
  });

  it('throws empty when clip has zero notes or only rests', () => {
    expectImportError(
      JSON.stringify({ notes: [], keys: [{ beat: 1, scale: 'major', tonic: 'C' }] }),
      'empty',
    );
    expectImportError(
      JSON.stringify({
        notes: [
          { startTick: 0, durationTicks: 480, isRest: true, sd: '', octave: 0, voice: 1 },
          { startTick: 480, durationTicks: 480, isRest: true, sd: '', octave: 0, voice: 1 },
        ],
        keys: [{ startTick: 0, scale: 'major', tonic: 'C' }],
      }),
      'empty',
    );
  });

  it('throws unsupported for tuplets that cannot be engraved', () => {
    const tuplet = { id: 't', n: 11, startTick: 0, spanTicks: 480 };
    const clip = {
      notes: [{ startTick: 0, durationTicks: 44, sd: '1', octave: 0, isRest: false, tuplet }],
      keys: [{ startTick: 0, scale: 'major', tonic: 'C' }],
    };
    expect(expectImportError(JSON.stringify(clip), 'unsupported').message).toContain('n=11');

    const legacy = { notes: [{ beat: 1, duration: 1, sd: '1', octave: 0 }], keys: [{ beat: 1, scale: 'major', tonic: 'C' }] };
    const wrapped = { ...legacy, modern: { payload: clip } };
    expectImportError(JSON.stringify(wrapped), 'unsupported');
  });

  it('throws unsupported naming the offending value for unknown scale, malformed sd, or bad tonic', () => {
    const scaleErr = expectImportError(
      JSON.stringify({
        notes: [{ beat: 1, duration: 1, sd: '1', octave: 0 }],
        keys: [{ beat: 1, scale: 'hirajoshi', tonic: 'C' }],
      }),
      'unsupported',
    );
    expect(scaleErr.message).toContain('hirajoshi');

    const sdErr = expectImportError(
      JSON.stringify({
        notes: [{ beat: 1, duration: 1, sd: '#9', octave: 0 }],
        keys: [{ beat: 1, scale: 'major', tonic: 'C' }],
      }),
      'unsupported',
    );
    expect(sdErr.message).toContain('#9');

    const tonicErr = expectImportError(
      JSON.stringify({
        notes: [{ beat: 1, duration: 1, sd: '1', octave: 0 }],
        keys: [{ beat: 1, scale: 'major', tonic: 'Q#' }],
      }),
      'unsupported',
    );
    expect(tonicErr.message).toContain('Q#');
  });
});
