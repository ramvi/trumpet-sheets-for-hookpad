import type { NoteNaming } from '../model/pitch';
import type { Meter } from '../import';
import type { RegisterProfile } from '../transpose';
import { PROFILE_FIELDS, isPickerMidi } from './profile';
import { METER_DENOMINATORS, METER_NUMERATORS, createInitialState } from './viewModel';
import type { AppState, Theme } from './viewModel';

export const STORAGE_KEY = 'trumpet-sheets.v1';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type PersistedState = Pick<
  AppState,
  'profile' | 'inputPitch' | 'fingerings' | 'noteNaming' | 'theme' | 'title' | 'rawInput' | 'meter'
>;

function getBrowserStorage(): StorageLike | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function oneOf<T extends string>(options: readonly T[], value: unknown, fallback: T): T {
  return options.includes(value as T) ? (value as T) : fallback;
}

function parseProfile(raw: unknown, fallback: RegisterProfile): RegisterProfile {
  const record = (raw ?? {}) as Record<string, unknown>;
  const parsed = { ...fallback };
  for (const { key } of PROFILE_FIELDS) {
    const value = record[key];
    if (!isPickerMidi(value)) {
      return { ...fallback };
    }
    parsed[key] = value;
  }
  return parsed;
}

function parseMeter(raw: unknown, fallback: Meter): Meter {
  const { numerator, denominator } = (raw ?? {}) as Meter;
  return METER_NUMERATORS.includes(numerator) && METER_DENOMINATORS.includes(denominator)
    ? { numerator, denominator }
    : fallback;
}

/** Reads saved settings; anything missing or invalid falls back to its default. */
export function loadPersistedState(storage: StorageLike | null = getBrowserStorage()): PersistedState {
  const defaults = createInitialState();
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(STORAGE_KEY) ?? 'null');
    if (typeof parsed !== 'object' || parsed === null) {
      return defaults;
    }
    const saved = parsed as Record<string, unknown>;
    return {
      profile: parseProfile(saved.profile, defaults.profile),
      inputPitch: oneOf(['concert', 'written'], saved.inputPitch, defaults.inputPitch),
      fingerings: oneOf(['every', 'first-in-run', 'off'], saved.fingerings, defaults.fingerings),
      noteNaming: oneOf<NoteNaming>(['B', 'H'], saved.noteNaming, defaults.noteNaming),
      theme: oneOf<Theme>(['system', 'light', 'dark'], saved.theme, defaults.theme),
      title: typeof saved.title === 'string' ? saved.title : defaults.title,
      rawInput: typeof saved.rawInput === 'string' ? saved.rawInput : defaults.rawInput,
      meter: parseMeter(saved.meter, defaults.meter),
    };
  } catch {
    return defaults;
  }
}

export function savePersistedState(
  state: PersistedState,
  storage: StorageLike | null = getBrowserStorage(),
): void {
  const { profile, inputPitch, fingerings, noteNaming, theme, title, rawInput, meter } = state;
  try {
    storage?.setItem(
      STORAGE_KEY,
      JSON.stringify({ profile, inputPitch, fingerings, noteNaming, theme, title, rawInput, meter }),
    );
  } catch {
    // Storage may be full or unavailable (private mode); settings just won't persist.
  }
}
