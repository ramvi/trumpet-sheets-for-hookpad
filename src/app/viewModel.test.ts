import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ImportError, importHookpad } from '../import';
import { referenceMelody } from '../../tests/melodies';
import type { KeyChange } from '../model/types';
import { DEFAULT_PROFILE, rankCandidates } from '../transpose';
import type { Candidate, RegisterProfile } from '../transpose';
import { formatMidiPitch, validateProfile } from './profile';
import { STORAGE_KEY, loadPersistedState, savePersistedState } from './storage';
import {
  computeView,
  createInitialState,
  formatHookpadInstruction,
  normalizeHookpadShift,
  summarizeOutOfRange,
  withRawInput,
} from './viewModel';

vi.mock('../import', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../import')>();
  return { ...actual, importHookpad: vi.fn(actual.importHookpad) };
});
vi.mock('../transpose', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../transpose')>();
  return { ...actual, rankCandidates: vi.fn(actual.rankCandidates) };
});

beforeEach(() => {
  vi.mocked(importHookpad).mockClear();
  vi.mocked(rankCandidates).mockClear();
});

/** A small Hookpad clip: scale degrees in a major key, one quarter note each, no meter. */
function clip(sds: string[], tonic = 'C', octave = 0): string {
  return JSON.stringify({
    notes: sds.map((sd, i) => ({
      startTick: i * 480,
      durationTicks: 480,
      sd,
      octave,
      isRest: false,
      voice: 1,
    })),
    keys: [{ startTick: 0, scale: 'major', tonic }],
  });
}

const MELODY = clip(['1', '2', '3', '5', '3', '2', '1']);

function stateWith(rawInput: string, patch: Partial<ReturnType<typeof createInitialState>> = {}) {
  return { ...withRawInput(createInitialState(), rawInput), ...patch };
}

function makeCandidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    semitones: 0,
    melody: referenceMelody,
    writtenKey: { tick: 0, tonic: { step: 'C', alter: 0 }, mode: 'minor' },
    hookpadKey: { tonic: { step: 'B', alter: -1 }, mode: 'minor' },
    lowest: { step: 'G', alter: 0, octave: 3 },
    highest: { step: 'E', alter: -1, octave: 5 },
    fits: true,
    outOfRange: [],
    overflowTotal: 0,
    score: 10,
    combinedScore: 1,
    tiebreak: { centerDistance: 2, hardFingerings: 0, accidentals: 0, absShift: 0 },
    ...overrides,
  };
}

describe('Hookpad instruction', () => {
  const sourceKey: KeyChange = { tick: 0, tonic: { step: 'C', alter: 0 }, mode: 'minor' };

  it('reduces shifts into -6..+6', () => {
    expect(normalizeHookpadShift(0)).toBe(0);
    expect(normalizeHookpadShift(6)).toBe(6);
    expect(normalizeHookpadShift(7)).toBe(-5);
    expect(normalizeHookpadShift(10)).toBe(-2);
    expect(normalizeHookpadShift(-8)).toBe(4);
  });

  it('says nothing needs to change for concert input with no shift', () => {
    expect(formatHookpadInstruction([sourceKey], makeCandidate(), 'concert')).toBe(
      'The clip is in C minor. No change needed in Hookpad.',
    );
  });

  it('moves the key down for written input, with singular and plural semitones', () => {
    expect(formatHookpadInstruction([sourceKey], makeCandidate(), 'written')).toBe(
      'The clip is in C minor. Move the Hookpad key down 2 semitones to B♭ minor.',
    );
    expect(formatHookpadInstruction([sourceKey], makeCandidate({ semitones: 3 }), 'written')).toBe(
      'The clip is in C minor. Move the Hookpad key up 1 semitone to B♭ minor.',
    );
  });

  it('moves the whole song when the key changes', () => {
    expect(
      formatHookpadInstruction(
        [
          { tick: 0, tonic: { step: 'C', alter: 0 }, mode: 'minor' },
          { tick: 1920, tonic: { step: 'E', alter: -1 }, mode: 'major' },
        ],
        makeCandidate(),
        'written',
      ),
    ).toBe('The clip starts in C minor. Move the whole song down 2 semitones to B♭ minor.');
  });
});

describe('computeView', () => {
  it('keeps the chosen meter when a clip is appended, but not when the text is replaced', () => {
    const state = stateWith(MELODY, { meter: { numerator: 3, denominator: 4 } });
    expect(withRawInput(state, `${MELODY}\n\n${MELODY}`).meter).toEqual(state.meter);
    expect(withRawInput(state, clip(['1'])).meter).toEqual({ numerator: 4, denominator: 4 });
    expect(withRawInput(state, '').meter).toEqual({ numerator: 4, denominator: 4 });
  });

  it('is empty for blank input', () => {
    const vm = computeView(createInitialState());
    expect(vm).toMatchObject({ status: 'empty', shouldRenderScore: false, canPrint: false });
  });

  it('computes a ready view with alternatives', () => {
    const vm = computeView(stateWith(MELODY));
    expect(vm.status).toBe('ready');
    expect(vm.shouldRenderScore).toBe(true);
    expect(vm.canPrint).toBe(true);
    expect(vm.result?.choices[0]).toMatchObject({ isRecommended: true, isSelected: true });
    expect(vm.result?.choices.length).toBeGreaterThan(1);
    expect(vm.result?.hookpadInstruction).toMatch(/^The clip is in C major\./);
    expect(vm.voices[0]?.displayLabel).toMatch(/\(7 notes\)$/);
  });

  it('applies a manual choice and clears it on new input', () => {
    const auto = computeView(stateWith(MELODY)).result!;
    const other = auto.choices.find((c) => !c.isRecommended)!;
    const manualState = stateWith(MELODY, { selectedCandidateSemitones: other.semitones });
    const manual = computeView(manualState).result!;
    expect(manual.candidate.semitones).toBe(other.semitones);
    expect(manual.choices.find((c) => c.semitones === other.semitones)?.isSelected).toBe(true);

    const reset = withRawInput(manualState, MELODY + ' ');
    expect(reset.selectedCandidateSemitones).toBeNull();
    expect(computeView(reset).result?.candidate.semitones).toBe(auto.candidate.semitones);
  });

  it('blocks the score when nothing fits until out-of-range is allowed', () => {
    const mixed = JSON.stringify({
      ...JSON.parse(MELODY),
      notes: [-2, 3, -2, 3].map((octave, i) => ({
        startTick: i * 480,
        durationTicks: 480,
        sd: '1',
        octave,
        isRest: false,
        voice: 1,
      })),
    });
    const before = computeView(stateWith(mixed));
    expect(before.status).toBe('ready');
    expect(before.showNoFitBlocker).toBe(true);
    expect(before.shouldRenderScore).toBe(false);
    expect(before.canPrint).toBe(false);
    expect(before.result?.outOfRangeSummary.length).toBeGreaterThan(0);

    const after = computeView({ ...stateWith(mixed), allowOutOfRange: true });
    expect(after.showNoFitBlocker).toBe(false);
    expect(after.shouldRenderScore).toBe(true);
    expect(after.canPrint).toBe(true);
  });

  it('never asks for an enharmonic key change that is not needed', () => {
    const cSharp = clip(['1', '3', '5'], 'C#');
    const { semitones } = computeView(stateWith(cSharp)).result!.choices[0]!;
    const unshifted = computeView(stateWith(cSharp, { selectedCandidateSemitones: 0 })).result!;
    expect(semitones).not.toBe(0);
    expect(unshifted.hookpadKeyLabel).toBe('C♯ major');
    expect(unshifted.hookpadInstruction).toBe('The clip is in C♯ major. No change needed in Hookpad.');
  });

  it('reports an invalid range without ranking', () => {
    const profile: RegisterProfile = { ...DEFAULT_PROFILE, comfortLow: 65, preferredLow: 62 };
    const vm = computeView(stateWith(MELODY, { profile }));
    expect(vm.status).toBe('profile-error');
    expect(vm.profileError).toContain('comfort range (low)');
    expect(vm.canPrint).toBe(false);
    expect(vm.voices).toHaveLength(1);
    expect(rankCandidates).not.toHaveBeenCalled();
  });

  it('shows import errors and unexpected errors differently', () => {
    const bad = computeView(stateWith('{bad'));
    expect(bad.status).toBe('import-error');
    expect(bad.importError).toBeTruthy();
    expect(bad.runtimeError).toBeNull();
    expect(bad.canPrint).toBe(false);

    vi.mocked(importHookpad).mockImplementationOnce(() => {
      throw new ImportError('unsupported', 'Custom import message');
    });
    expect(computeView(stateWith(MELODY)).importError).toBe('Custom import message');

    vi.mocked(importHookpad).mockImplementationOnce(() => {
      throw new Error('boom');
    });
    const crash = computeView(stateWith(MELODY));
    expect(crash).toMatchObject({ status: 'runtime-error', importError: null });
    expect(crash.runtimeError).toContain('boom');

    vi.mocked(rankCandidates).mockImplementationOnce(() => {
      throw new Error('ranking failed');
    });
    const rankCrash = computeView(stateWith(MELODY));
    expect(rankCrash.status).toBe('runtime-error');
    expect(rankCrash.runtimeError).toContain('ranking failed');
    expect(rankCrash.canPrint).toBe(false);
  });

  it('summarizes the pasted clips', () => {
    expect(computeView(stateWith(MELODY)).clipSummary).toBe('7 notes');
    const two = computeView(stateWith(`${MELODY}\n\n${MELODY}`));
    expect(two.clipSummary).toBe('14 notes from 2 clips');
  });
});

describe('note naming', () => {
  const B_NATURAL = { step: 'B', alter: 0, octave: 4 } as const;

  it('names B natural as H in labels but never B flat', () => {
    expect(formatMidiPitch(71)).toBe('B4');
    expect(formatMidiPitch(71, 'H')).toBe('H4');
    expect(formatMidiPitch(70, 'H')).toBe('B♭4');
    const item = summarizeOutOfRange(
      [{ pitch: B_NATURAL, semitonesOutside: 1, side: 'high' }],
      'H',
    )[0]!;
    expect(item.label).toBe('H4');
    expect(item.description).toBe('H4 is 1 semitone too high (once)');
  });

  it('applies to range errors', () => {
    const profile = { ...DEFAULT_PROFILE, limitLow: 71 };
    expect(validateProfile(profile, 'H')).toContain('(H4)');
    expect(validateProfile(profile)).toContain('(B4)');
    expect(validateProfile(DEFAULT_PROFILE, 'H')).toBeNull();
  });

  it('relabels result keys and ranges but keeps Hookpad keys in English naming', () => {
    const clipInB = clip(['1', '2', '3', '5', '3', '2', '1'], 'B');
    const asB = computeView(stateWith(clipInB, { noteNaming: 'B' }));
    const asH = computeView(stateWith(clipInB, { noteNaming: 'H' }));
    const h = (text: string) => text.replace(/B(?!♭)/g, 'H');

    expect(asH.result?.writtenKeyLabel).toBe(h(asB.result!.writtenKeyLabel));
    expect(asH.result?.rangeLabel).toBe(h(asB.result!.rangeLabel));
    expect(asH.result?.choices.map((c) => c.writtenKeyLabel)).toEqual(
      asB.result?.choices.map((c) => h(c.writtenKeyLabel)),
    );
    expect(asH.result?.limitsLabel).toBe(h(asB.result!.limitsLabel));

    expect(asB.result?.hookpadInstruction).toMatch(/^The clip is in B major\./);
    expect(asH.result?.hookpadInstruction).toBe(asB.result?.hookpadInstruction);
    expect(asH.result?.hookpadKeyLabel).toBe(asB.result?.hookpadKeyLabel);
  });
});

describe('persisted state', () => {
  function memoryStorage(initial?: unknown) {
    const data = new Map<string, string>();
    if (initial !== undefined) {
      data.set(STORAGE_KEY, typeof initial === 'string' ? initial : JSON.stringify(initial));
    }
    return {
      data,
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
    };
  }

  const saved = {
    profile: { ...DEFAULT_PROFILE, limitHigh: 77 },
    inputPitch: 'written' as const,
    fingerings: 'off' as const,
    noteNaming: 'H' as const,
    theme: 'dark' as const,
    title: 'My song',
    rawInput: MELODY,
    meter: { numerator: 3, denominator: 4 },
  };

  it('uses a versioned key and round-trips every field', () => {
    expect(STORAGE_KEY).toBe('trumpet-sheets.v1');
    const storage = memoryStorage();
    savePersistedState({ ...createInitialState(), ...saved }, storage);
    expect(storage.data.has(STORAGE_KEY)).toBe(true);
    expect(loadPersistedState(storage)).toEqual(saved);
  });

  it('falls back to defaults for missing, unknown or malformed values', () => {
    const defaults = createInitialState();
    expect(loadPersistedState(memoryStorage())).toMatchObject({ fingerings: 'every', noteNaming: 'B' });
    expect(loadPersistedState(memoryStorage('not json'))).toMatchObject({ title: defaults.title });
    expect(loadPersistedState(memoryStorage('[1]'))).toMatchObject({ inputPitch: 'concert' });

    const loaded = loadPersistedState(
      memoryStorage({
        ...saved,
        fingerings: 'sometimes',
        noteNaming: 'X',
        theme: 'neon',
        meter: { numerator: 3, denominator: 0 },
        inputPitch: 'loud',
        title: 5,
        profile: { ...saved.profile, limitLow: 12 },
      }),
    );
    expect(loaded).toMatchObject({
      fingerings: 'every',
      noteNaming: 'B',
      theme: 'system',
      meter: defaults.meter,
      inputPitch: 'concert',
      title: defaults.title,
      profile: DEFAULT_PROFILE,
      rawInput: MELODY,
    });
  });

  it('survives throwing storage', () => {
    const throwing = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('quota');
      },
    };
    expect(() => savePersistedState(createInitialState(), throwing)).not.toThrow();
    expect(loadPersistedState(throwing)).toEqual(loadPersistedState(null));
  });
});
