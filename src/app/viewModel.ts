import { ImportError, importHookpad } from '../import';
import type { ImportedVoice, Meter } from '../import';
import { formatKey, formatPitch, pitchToMidi } from '../model/pitch';
import type { NoteNaming } from '../model/pitch';
import type { KeyChange } from '../model/types';
import type { FingeringRepeat } from '../notation';
import { DEFAULT_PROFILE, rankCandidates, toWrittenBase } from '../transpose';
import type { Candidate, InputPitch, OutOfRangeNote, Ranking, RegisterProfile } from '../transpose';
import { formatMidiPitch, validateProfile } from './profile';

export const METER_NUMERATORS: readonly number[] = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
export const METER_DENOMINATORS: readonly number[] = [2, 4, 8];
const DEFAULT_METER: Meter = { numerator: 4, denominator: 4 };
export const DEFAULT_TITLE = 'Melody for B♭ trumpet';
const MAX_ALTERNATIVES = 4;

export type Theme = 'system' | 'light' | 'dark';
export type FingeringMode = FingeringRepeat | 'off';

export interface AppState {
  rawInput: string;
  inputPitch: InputPitch;
  fingerings: FingeringMode;
  noteNaming: NoteNaming;
  theme: Theme;
  selectedVoiceId: string | null;
  meter: Meter;
  title: string;
  profile: RegisterProfile;
  selectedCandidateSemitones: number | null;
  allowOutOfRange: boolean;
}

interface OutOfRangeSummaryItem {
  label: string;
  midi: number;
  side: 'low' | 'high';
  semitonesOutside: number;
  count: number;
  description: string;
}

interface CandidateChoiceView {
  semitones: number;
  writtenKeyLabel: string;
  rangeLabel: string;
  lowMidi: number;
  highMidi: number;
  fits: boolean;
  isRecommended: boolean;
  isSelected: boolean;
}

interface ResultView {
  writtenKeyLabel: string;
  hookpadKeyLabel: string;
  hookpadInstruction: string;
  rangeLabel: string;
  candidate: Candidate;
  choices: CandidateChoiceView[];
  anyFits: boolean;
  outOfRangeSummary: OutOfRangeSummaryItem[];
  limitsLabel: string;
}

export interface AppViewModel {
  status: 'empty' | 'import-error' | 'profile-error' | 'runtime-error' | 'ready';
  importError: string | null;
  profileError: string | null;
  runtimeError: string | null;
  clipSummary: string | null;
  warnings: string[];
  voices: { id: string; displayLabel: string }[];
  selectedVoiceId: string | null;
  result: ResultView | null;
  showNoFitBlocker: boolean;
  shouldRenderScore: boolean;
  canPrint: boolean;
}

const EMPTY_VIEW: AppViewModel = {
  status: 'empty',
  importError: null,
  profileError: null,
  runtimeError: null,
  clipSummary: null,
  warnings: [],
  voices: [],
  selectedVoiceId: null,
  result: null,
  showNoFitBlocker: false,
  shouldRenderScore: false,
  canPrint: false,
};

export function createInitialState(): AppState {
  return {
    rawInput: '',
    inputPitch: 'concert',
    fingerings: 'every',
    noteNaming: 'B',
    theme: 'system',
    selectedVoiceId: null,
    meter: DEFAULT_METER,
    title: DEFAULT_TITLE,
    profile: { ...DEFAULT_PROFILE },
    selectedCandidateSemitones: null,
    allowOutOfRange: false,
  };
}

/** New text resets per-clip choices. Appending a clip keeps the meter chosen for the ones before it. */
export function withRawInput(state: AppState, rawInput: string): AppState {
  return {
    ...state,
    rawInput,
    selectedVoiceId: null,
    meter: state.rawInput && rawInput.startsWith(state.rawInput) ? state.meter : DEFAULT_METER,
    selectedCandidateSemitones: null,
    allowOutOfRange: false,
  };
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/** Reduces a semitone shift modulo 12 into -6..+6. */
export function normalizeHookpadShift(rawShift: number): number {
  const mod = ((rawShift % 12) + 12) % 12;
  return mod > 6 ? mod - 12 : mod;
}

function hookpadShift(candidate: Candidate, inputPitch: InputPitch): number {
  return normalizeHookpadShift(inputPitch === 'concert' ? candidate.semitones : candidate.semitones - 2);
}

/**
 * Tells the user how to change the key in Hookpad. Hookpad always names notes
 * in English, so keys here use "B" naming whatever the note naming setting is.
 */
export function formatHookpadInstruction(
  sourceKeys: readonly KeyChange[],
  candidate: Candidate,
  inputPitch: InputPitch,
): string {
  const changesKey = sourceKeys.length > 1;
  const source = `The clip ${changesKey ? 'starts' : 'is'} in ${formatKey(sourceKeys[0]!)}.`;
  const shift = hookpadShift(candidate, inputPitch);
  if (shift === 0) {
    return `${source} No change needed in Hookpad.`;
  }
  return `${source} Move ${changesKey ? 'the whole song' : 'the Hookpad key'} ${shift > 0 ? 'up' : 'down'} ${plural(Math.abs(shift), 'semitone')} to ${formatKey(candidate.hookpadKey)}.`;
}

/** Groups out-of-range notes by written pitch and side. */
export function summarizeOutOfRange(
  outOfRange: readonly OutOfRangeNote[],
  naming?: NoteNaming,
): OutOfRangeSummaryItem[] {
  const grouped = new Map<string, Omit<OutOfRangeSummaryItem, 'description'>>();
  for (const note of outOfRange) {
    const label = formatPitch(note.pitch, naming);
    const groupKey = `${label}|${note.side}`;
    const existing = grouped.get(groupKey);
    if (existing) {
      existing.count += 1;
      existing.semitonesOutside = Math.max(existing.semitonesOutside, note.semitonesOutside);
    } else {
      grouped.set(groupKey, {
        label,
        midi: pitchToMidi(note.pitch),
        side: note.side,
        semitonesOutside: note.semitonesOutside,
        count: 1,
      });
    }
  }
  return [...grouped.values()]
    .sort((a, b) => a.midi - b.midi)
    .map((item) => ({
      ...item,
      description: `${item.label} is ${plural(item.semitonesOutside, 'semitone')} too ${item.side} (${item.count === 1 ? 'once' : `${item.count} times`})`,
    }));
}

function voiceOptions(voices: readonly ImportedVoice[]): AppViewModel['voices'] {
  return voices.map((v) => ({
    id: v.id,
    displayLabel: `${v.label} (${plural(v.onsets, 'note')})`,
  }));
}

export function formatError(context: string, err: unknown): string {
  return err instanceof Error && err.message.trim() ? `${context}: ${err.message}` : `${context}.`;
}

function buildChoices(ranking: Ranking, selected: Candidate, naming: NoteNaming): CandidateChoiceView[] {
  const { best } = ranking;
  const alternatives = ranking.candidates.filter((c) => c.semitones !== best.semitones);
  return [best, ...alternatives.slice(0, MAX_ALTERNATIVES)].map((c) => ({
    semitones: c.semitones,
    writtenKeyLabel: formatKey(c.writtenKey, naming),
    rangeLabel: `${formatPitch(c.lowest, naming)}–${formatPitch(c.highest, naming)}`,
    lowMidi: pitchToMidi(c.lowest),
    highMidi: pitchToMidi(c.highest),
    fits: c.fits,
    isRecommended: c.semitones === best.semitones,
    isSelected: c.semitones === selected.semitones,
  }));
}

/** Pure computation from the UI state to everything the screen shows. */
export function computeView(state: AppState): AppViewModel {
  const naming = state.noteNaming;
  const profileError = validateProfile(state.profile, naming);
  const base: AppViewModel = { ...EMPTY_VIEW, profileError };

  if (state.rawInput.trim().length === 0) {
    return base;
  }

  let imported;
  try {
    imported = importHookpad(state.rawInput, state.meter);
  } catch (err: unknown) {
    return err instanceof ImportError
      ? { ...base, status: 'import-error', importError: err.message }
      : {
          ...base,
          status: 'runtime-error',
          runtimeError: formatError('Could not process the melody', err),
        };
  }

  const { parts, warnings } = imported;
  const active =
    imported.voices.find((v) => v.id === state.selectedVoiceId) ?? imported.voices[0];
  if (!active) {
    return {
      ...base,
      status: 'import-error',
      importError: 'The clip has no voices with notes.',
      warnings,
    };
  }

  const withClip: AppViewModel = {
    ...base,
    clipSummary: `${plural(active.onsets, 'note')}${parts > 1 ? ` from ${parts} clips` : ''}`,
    warnings,
    voices: voiceOptions(imported.voices),
    selectedVoiceId: active.id,
  };

  if (profileError) {
    return { ...withClip, status: 'profile-error' };
  }

  let ranking: Ranking;
  try {
    ranking = rankCandidates(toWrittenBase(active.melody, state.inputPitch), state.profile);
  } catch (err: unknown) {
    return {
      ...withClip,
      status: 'runtime-error',
      runtimeError: formatError('Could not process the melody', err),
    };
  }

  const manualMatch = ranking.candidates.find(
    (c) => c.semitones === state.selectedCandidateSemitones,
  );
  const candidate = manualMatch ?? ranking.best;
  const shift = hookpadShift(candidate, state.inputPitch);
  const showNoFitBlocker = !ranking.anyFits && !state.allowOutOfRange;

  return {
    ...withClip,
    status: 'ready',
    result: {
      writtenKeyLabel: formatKey(candidate.writtenKey, naming),
      hookpadKeyLabel: formatKey(shift === 0 ? active.melody.keys[0]! : candidate.hookpadKey),
      hookpadInstruction: formatHookpadInstruction(active.melody.keys, candidate, state.inputPitch),
      rangeLabel: `${formatPitch(candidate.lowest, naming)}–${formatPitch(candidate.highest, naming)}`,
      candidate,
      choices: buildChoices(ranking, candidate, naming),
      anyFits: ranking.anyFits,
      outOfRangeSummary: summarizeOutOfRange(candidate.outOfRange, naming),
      limitsLabel: `${formatMidiPitch(state.profile.limitLow, naming)}–${formatMidiPitch(state.profile.limitHigh, naming)}`,
    },
    showNoFitBlocker,
    shouldRenderScore: !showNoFitBlocker,
    canPrint: !showNoFitBlocker,
  };
}
