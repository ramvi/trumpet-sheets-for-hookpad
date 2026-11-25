import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { referenceMelody } from '../../tests/melodies';
import { describe, expect, it } from 'vitest';
import { pitchToMidi } from '../model/pitch';
import type { Pitch } from '../model/types';
import { ImportError, importHookpad } from './index';

const FIXTURES_DIR = resolve(process.cwd(), 'tests/fixtures');

const twoPartsText = readFileSync(resolve(FIXTURES_DIR, 'two-parts.txt'), 'utf8');
const hookpadReferenceText = readFileSync(resolve(FIXTURES_DIR, 'reference-written.json'), 'utf8');

function expectImportError(input: string, expectedCode: ImportError['code']): ImportError {
  try {
    importHookpad(input);
    throw new Error(`Expected ImportError(${expectedCode}), but import succeeded`);
  } catch (err) {
    expect(err).toBeInstanceOf(ImportError);
    const importErr = err as ImportError;
    expect(importErr.code).toBe(expectedCode);
    expect(importErr.message.length).toBeGreaterThan(10);
    return importErr;
  }
}

function makeModernBar(params: {
  tonic?: string;
  scale?: string;
  notes: Array<{
    startTick: number;
    durationTicks: number;
    sd?: string;
    octave?: number;
    isRest?: boolean;
    voice?: number;
    id?: string;
  }>;
  keys?: Array<{ startTick: number; scale: string; tonic: string }>;
  meters?: Array<Record<string, unknown>>;
  extra?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    ...params.extra,
    modern: {
      version: 'hooktheory-clipboard-v1',
      payload: {
        notes: params.notes.map((n, idx) => ({
          id: n.id ?? `n${idx}`,
          sd: n.sd ?? '1',
          octave: n.octave ?? 0,
          startTick: n.startTick,
          durationTicks: n.durationTicks,
          isRest: n.isRest ?? false,
          voice: n.voice ?? 1,
        })),
        keys: params.keys ?? [
          { startTick: 0, scale: params.scale ?? 'major', tonic: params.tonic ?? 'C' },
        ],
        meters: params.meters ?? [],
        baseTick: 0,
      },
    },
  };
}

describe('multi-clip import — real fixtures', () => {
  it('imports two-parts.txt as one continuous B-minor song', () => {
    const result = importHookpad(twoPartsText);

    expect(result.parts).toBe(2);
    expect(result.warnings).toEqual([]);
    expect(result.voices).toHaveLength(1);

    const voice = result.voices[0]!;
    expect(voice.id).toBe('1');
    expect(voice.label).toBe('Voice 1');
    expect(voice.onsets).toBe(84);

    const { melody } = voice;
    expect(melody.events).toHaveLength(86);
    const pitchedEvents = melody.events.filter((ev) => ev.pitch !== null);
    const restEvents = melody.events.filter((ev) => ev.pitch === null);
    expect(pitchedEvents).toHaveLength(84);
    expect(restEvents).toHaveLength(2);

    expect(melody.keys).toEqual([
      { tick: 0, tonic: { step: 'B', alter: 0 }, mode: 'minor' },
    ]);
    expect(melody.meters).toEqual([{ tick: 0, numerator: 4, denominator: 4 }]);
    expect(melody.endTick).toBe(30720);

    // Boundary between part 1 (64 events) and part 2 (starts with a 480-tick rest at 15360).
    const lastOfPart1 = melody.events[63]!;
    const firstOfPart2 = melody.events[64]!;
    expect(lastOfPart1.tick + lastOfPart1.durationTicks).toBe(15360);
    expect(firstOfPart2.tick).toBe(15360);
    expect(firstOfPart2.durationTicks).toBe(480);
    expect(firstOfPart2.pitch).toBeNull();

    // Pitch checks: first pitch B4 (MIDI 71), range B3 (59) .. D5 (74).
    const firstPitch = melody.events[0]!.pitch!;
    expect(firstPitch).toEqual({ step: 'B', alter: 0, octave: 4 });
    expect(pitchToMidi(firstPitch)).toBe(71);

    const midis = pitchedEvents.map((ev) => pitchToMidi(ev.pitch!));
    expect(Math.min(...midis)).toBe(59);
    expect(Math.max(...midis)).toBe(74);

    // Event sequence equals importing part 1 and part 2 separately and shifting part 2 by 15360.
    const [rawPart1, rawPart2] = twoPartsText.trim().split(/\r?\n\s*\r?\n/);
    const part1Res = importHookpad(rawPart1!);
    const part2Res = importHookpad(rawPart2!);
    expect(part1Res.parts).toBe(1);
    expect(part2Res.parts).toBe(1);
    const expectedEvents = [
      ...part1Res.voices[0]!.melody.events,
      ...part2Res.voices[0]!.melody.events.map((ev) => ({
        ...ev,
        tick: ev.tick + 15360,
      })),
    ];
    expect(melody.events).toEqual(expectedEvents);
  });

  it('imports reference-written.json pasted twice with shifted tuplets and single key', () => {
    const doubled = `${hookpadReferenceText.trim()}\n\n${hookpadReferenceText.trim()}`;
    const result = importHookpad(doubled);

    expect(result.parts).toBe(2);
    expect(result.warnings).toEqual([]);
    expect(result.voices).toHaveLength(1);

    const voice = result.voices[0]!;
    expect(voice.onsets).toBe(72);
    expect(voice.melody.endTick).toBe(34560);
    expect(voice.melody.keys).toEqual(referenceMelody.keys);
    expect(voice.melody.keys).toHaveLength(1);
    expect(voice.melody.tuplets).toEqual([
      ...referenceMelody.tuplets,
      ...referenceMelody.tuplets.map((t) => ({ ...t, startTick: t.startTick + 17280 })),
    ]);
    expect(voice.melody.tuplets).toHaveLength(6);
  });
});

describe('multi-clip import — bar alignment, keys, meters, voices', () => {
  it('aligns next part to the next bar line with a warning when previous part ends mid-bar', () => {
    const part1 = makeModernBar({
      notes: [
        { startTick: 0, durationTicks: 480, sd: '1' },
        { startTick: 480, durationTicks: 480, sd: '2' },
        { startTick: 960, durationTicks: 480, sd: '3' },
      ],
    });
    const part2 = makeModernBar({
      notes: [{ startTick: 0, durationTicks: 480, sd: '5' }],
    });

    const result = importHookpad(`${JSON.stringify(part1)}\n\n${JSON.stringify(part2)}`);
    expect(result.parts).toBe(2);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/Part 1/i);
    expect(result.warnings[0]).toMatch(/bar/i);

    const events = result.voices[0]!.melody.events;
    expect(events).toHaveLength(4);
    expect(events[2]!.tick + events[2]!.durationTicks).toBe(1440);
    expect(events[3]!.tick).toBe(1920);
    expect(result.voices[0]!.melody.endTick).toBe(2400);
  });

  it('starts the next clip on a bar line of the chosen meter', () => {
    const clip = JSON.stringify({
      notes: [0, 1, 2].map((i) => ({ startTick: i * 480, durationTicks: 480, sd: '1', octave: 0, isRest: false, voice: 1 })),
      keys: [{ startTick: 0, scale: 'major', tonic: 'C' }],
    });
    const threeFour = { numerator: 3, denominator: 4 };
    const { voices, warnings } = importHookpad(clip + clip, threeFour);
    expect(warnings).toEqual([]);
    expect(voices[0]!.melody.meters).toEqual([{ tick: 0, ...threeFour }]);
    expect(voices[0]!.melody.events[3]!.tick).toBe(1440);
  });

  it('reads one Hookpad beat as an eighth note in 6/8', () => {
    const text = readFileSync(resolve(FIXTURES_DIR, 'six-eight.json'), 'utf8');
    const { melody } = importHookpad(text, { numerator: 6, denominator: 8 }).voices[0]!;
    expect(melody.events.map((e) => [e.tick, e.durationTicks])).toEqual([
      [0, 240], [240, 240], [480, 240], [720, 240], [960, 240], [1200, 240],
      [1440, 720], [2160, 480], [2640, 240],
    ]);
    expect(melody.endTick).toBe(2880);
  });

  it('scales tuplets and key changes with the beat', () => {
    const tuplet = { id: 't', n: 3, startTick: 480, spanTicks: 480 };
    const clip = {
      notes: [480, 640, 800].map((startTick) => ({ startTick, durationTicks: 160, sd: '1', octave: 0, isRest: false, tuplet })),
      keys: [
        { startTick: 0, scale: 'major', tonic: 'C' },
        { startTick: 640, scale: 'major', tonic: 'D' },
      ],
    };
    const { melody } = importHookpad(JSON.stringify(clip), { numerator: 6, denominator: 8 }).voices[0]!;
    expect(melody.tuplets).toEqual([{ startTick: 240, spanTicks: 240, actual: 3, normal: 2 }]);
    expect(melody.events.map((e) => [e.tick, e.durationTicks])).toEqual([[240, 80], [320, 80], [400, 80]]);
    expect(melody.keys.map((k) => k.tick)).toEqual([0, 320]);
  });

  it('inserts a key change at the boundary when parts have different keys and resolves part 2 pitches in its own key', () => {
    const part1 = makeModernBar({
      tonic: 'C',
      scale: 'major',
      notes: [{ startTick: 0, durationTicks: 1920, sd: '1' }],
    });
    const part2 = makeModernBar({
      tonic: 'D',
      scale: 'major',
      notes: [
        { startTick: 0, durationTicks: 960, sd: '1' },
        { startTick: 960, durationTicks: 960, sd: '3' },
      ],
      keys: [
        { startTick: 0, scale: 'major', tonic: 'D' },
        { startTick: 960, scale: 'minor', tonic: 'D' },
      ],
    });

    const result = importHookpad(`${JSON.stringify(part1)}\n\n${JSON.stringify(part2)}`);
    const { melody } = result.voices[0]!;

    expect(melody.keys).toEqual([
      { tick: 0, tonic: { step: 'C', alter: 0 }, mode: 'major' },
      { tick: 1920, tonic: { step: 'D', alter: 0 }, mode: 'major' },
      { tick: 2880, tonic: { step: 'D', alter: 0 }, mode: 'minor' },
    ]);
    // Part 1: C4; Part 2 beat 1 in D major: D4; Part 2 beat 3 in D minor: F4 (minor 3rd).
    expect(melody.events.map((e) => e.pitch)).toEqual([
      { step: 'C', alter: 0, octave: 4 },
      { step: 'D', alter: 0, octave: 4 },
      { step: 'F', alter: 0, octave: 4 },
    ]);

    // Enharmonic tonic spelling difference (C# major -> Db major) still emits a key change.
    const cSharp = makeModernBar({
      tonic: 'C#',
      scale: 'major',
      notes: [{ startTick: 0, durationTicks: 1920, sd: '1' }],
    });
    const dFlat = makeModernBar({
      tonic: 'Db',
      scale: 'major',
      notes: [{ startTick: 0, durationTicks: 1920, sd: '1' }],
    });
    const enharmonicRes = importHookpad(`${JSON.stringify(cSharp)}\n${JSON.stringify(dFlat)}`);
    expect(enharmonicRes.voices[0]!.melody.keys).toEqual([
      { tick: 0, tonic: { step: 'C', alter: 1 }, mode: 'major' },
      { tick: 1920, tonic: { step: 'D', alter: -1 }, mode: 'major' },
    ]);

    // If part 1 modulated to G major mid-clip and part 2 starts in G major, no redundant key at boundary.
    const modulatedPart1 = makeModernBar({
      notes: [
        { startTick: 0, durationTicks: 960, sd: '1' },
        { startTick: 960, durationTicks: 960, sd: '1' },
      ],
      keys: [
        { startTick: 0, scale: 'major', tonic: 'C' },
        { startTick: 960, scale: 'major', tonic: 'G' },
      ],
    });
    const gPart2 = makeModernBar({
      tonic: 'G',
      scale: 'major',
      notes: [{ startTick: 0, durationTicks: 1920, sd: '1' }],
    });
    const modRes = importHookpad(`${JSON.stringify(modulatedPart1)}\n${JSON.stringify(gPart2)}`);
    expect(modRes.voices[0]!.melody.keys).toEqual([
      { tick: 0, tonic: { step: 'C', alter: 0 }, mode: 'major' },
      { tick: 960, tonic: { step: 'G', alter: 0 }, mode: 'major' },
    ]);
  });

  it('supports all separators (blank lines, space, no whitespace }{, comma, JSON array) and braces inside JSON strings', () => {
    const part1 = makeModernBar({
      notes: [{ startTick: 0, durationTicks: 1920, sd: '1', id: 'a}b{c"d\\e' }],
      extra: { noteText: 'contains } and { and \\" } braces' },
    });
    const part2 = makeModernBar({
      notes: [{ startTick: 0, durationTicks: 1920, sd: '5', id: 'x{y}z' }],
      extra: { noteText: '{nested} [brackets]' },
    });

    const s1 = JSON.stringify(part1);
    const s2 = JSON.stringify(part2);

    const inputs = [
      `${s1}\n\n\n${s2}`,
      `${s1} ${s2}`,
      `${s1}${s2}`,
      `${s1}, ${s2}`,
      `${s1},${s2}`,
      JSON.stringify([part1, part2]),
    ];

    const expectedPitches: Pitch[] = [
      { step: 'C', alter: 0, octave: 4 },
      { step: 'G', alter: 0, octave: 4 },
    ];

    for (const input of inputs) {
      const res = importHookpad(input);
      expect(res.parts).toBe(2);
      expect(res.warnings).toEqual([]);
      expect(res.voices[0]!.melody.events.map((e) => e.tick)).toEqual([0, 1920]);
      expect(res.voices[0]!.melody.events.map((e) => e.pitch)).toEqual(expectedPitches);
      expect(res.voices[0]!.melody.endTick).toBe(3840);
    }
  });

  it('joins a legacy-only part followed by a modern part on one timeline', () => {
    const legacyPart = {
      notes: [
        { beat: 1, duration: 2, sd: '1', octave: 0, isRest: false },
        { beat: 3, duration: 2, sd: '3', octave: 0, isRest: false },
      ],
      keys: [{ beat: 1, scale: 'major', tonic: 'C' }],
    };
    const modernPart = makeModernBar({
      tonic: 'C',
      scale: 'major',
      notes: [
        { startTick: 0, durationTicks: 960, sd: '5' },
        { startTick: 960, durationTicks: 960, sd: '1', octave: 1 },
      ],
    });

    const res = importHookpad(`${JSON.stringify(legacyPart)}\n\n${JSON.stringify(modernPart)}`);
    expect(res.parts).toBe(2);
    expect(res.warnings).toEqual([]);
    expect(res.voices).toHaveLength(1);
    expect(res.voices[0]!.onsets).toBe(4);
    expect(res.voices[0]!.melody.events.map((e) => e.tick)).toEqual([0, 960, 1920, 2880]);
    expect(res.voices[0]!.melody.endTick).toBe(3840);
  });

  it('builds the union of voices when voice 2 exists only in part 2', () => {
    const part1 = makeModernBar({
      notes: [
        { startTick: 0, durationTicks: 960, sd: '1', voice: 1 },
        { startTick: 960, durationTicks: 960, sd: '2', voice: 1 },
      ],
    });
    const part2 = makeModernBar({
      notes: [
        { startTick: 0, durationTicks: 480, sd: '3', voice: 1 },
        { startTick: 0, durationTicks: 960, sd: '5', voice: 2 },
        { startTick: 960, durationTicks: 960, sd: '6', voice: 2 },
      ],
    });

    const res = importHookpad(`${JSON.stringify(part1)}\n\n${JSON.stringify(part2)}`);
    expect(res.parts).toBe(2);
    expect(res.voices).toHaveLength(2);

    const v1 = res.voices[0]!;
    expect(v1.id).toBe('1');
    expect(v1.onsets).toBe(3);
    expect(v1.melody.events.map((e) => e.tick)).toEqual([0, 960, 1920]);
    expect(v1.melody.endTick).toBe(2400);

    const v2 = res.voices[1]!;
    expect(v2.id).toBe('2');
    expect(v2.onsets).toBe(2);
    expect(v2.melody.events.map((e) => e.tick)).toEqual([1920, 2880]);
    expect(v2.melody.endTick).toBe(3840);
  });

  it('allows a rest-only part to contribute its time and throws empty if no part has pitched notes', () => {
    const pitchedPart = makeModernBar({
      notes: [{ startTick: 0, durationTicks: 1920, sd: '1' }],
    });
    const restPart = makeModernBar({
      notes: [{ startTick: 0, durationTicks: 1920, sd: '', isRest: true }],
    });

    const combined = importHookpad(
      `${JSON.stringify(pitchedPart)}\n${JSON.stringify(restPart)}\n${JSON.stringify(pitchedPart)}`,
    );
    expect(combined.parts).toBe(3);
    expect(combined.warnings).toEqual([]);
    expect(combined.voices[0]!.onsets).toBe(2);
    expect(combined.voices[0]!.melody.events.map((e) => ({ tick: e.tick, isRest: e.pitch === null }))).toEqual([
      { tick: 0, isRest: false },
      { tick: 1920, isRest: true },
      { tick: 3840, isRest: false },
    ]);
    expect(combined.voices[0]!.melody.endTick).toBe(5760);

    expectImportError(`${JSON.stringify(restPart)}\n${JSON.stringify(restPart)}`, 'empty');
  });

  it('gives single-clip inputs identical results plus parts: 1', () => {
    const single = importHookpad(hookpadReferenceText);
    expect(single.parts).toBe(1);
    expect(single.warnings).toEqual([]);
    expect(single.voices[0]!.melody).toEqual(referenceMelody);

    const wrappedSingle = importHookpad(`[${hookpadReferenceText}]`);
    expect(wrappedSingle.parts).toBe(1);
    expect(wrappedSingle.voices[0]!.melody).toEqual(referenceMelody);
  });
});

describe('multi-clip import — errors', () => {
  it('prefixes errors in part 2 with "Part 2:"', () => {
    const validPart1 = makeModernBar({
      notes: [{ startTick: 0, durationTicks: 1920, sd: '1' }],
    });
    const badScalePart2 = makeModernBar({
      tonic: 'C',
      scale: 'hirajoshi',
      notes: [{ startTick: 0, durationTicks: 1920, sd: '1' }],
    });

    const err = expectImportError(
      `${JSON.stringify(validPart1)}\n\n${JSON.stringify(badScalePart2)}`,
      'unsupported',
    );
    expect(err.message.startsWith('Part 2:')).toBe(true);
    expect(err.message).toContain('hirajoshi');
  });

  it('throws invalid-json for trailing garbage, stray commas, or truncated second clip', () => {
    const validPart1 = JSON.stringify(
      makeModernBar({ notes: [{ startTick: 0, durationTicks: 1920, sd: '1' }] }),
    );

    expectImportError(`${validPart1} hei`, 'invalid-json');
    expectImportError(`${validPart1},`, 'invalid-json');
    expectImportError(`,${validPart1}`, 'invalid-json');
    expectImportError(`${validPart1},,${validPart1}`, 'invalid-json');
    expectImportError(`${validPart1} {"notes": [`, 'invalid-json');
    expectImportError('not json at all', 'invalid-json');
    expectImportError('[]', 'not-hookpad');
  });
});
