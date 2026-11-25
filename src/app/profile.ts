import { formatPitch } from '../model/pitch';
import type { NoteNaming } from '../model/pitch';
import type { Pitch, PitchClass } from '../model/types';
import type { RegisterProfile } from '../transpose';

/** Lowest selectable written trumpet pitch: F♯3. */
export const MIN_PICKER_MIDI = 54;
/** Highest selectable written trumpet pitch: C6. */
export const MAX_PICKER_MIDI = 84;

const PICKER_PITCH_CLASSES: readonly PitchClass[] = [
  { step: 'C', alter: 0 },
  { step: 'C', alter: 1 },
  { step: 'D', alter: 0 },
  { step: 'E', alter: -1 },
  { step: 'E', alter: 0 },
  { step: 'F', alter: 0 },
  { step: 'F', alter: 1 },
  { step: 'G', alter: 0 },
  { step: 'A', alter: -1 },
  { step: 'A', alter: 0 },
  { step: 'B', alter: -1 },
  { step: 'B', alter: 0 },
];

function midiToPickerPitch(midi: number): Pitch {
  return { ...PICKER_PITCH_CLASSES[midi % 12]!, octave: Math.floor(midi / 12) - 1 };
}

/** Formats a MIDI number as a written pitch, e.g. "G3", "B♭4", "F♯4". */
export function formatMidiPitch(midi: number, naming?: NoteNaming): string {
  return formatPitch(midiToPickerPitch(midi), naming);
}

export const PICKER_MIDIS: readonly number[] = Array.from(
  { length: MAX_PICKER_MIDI - MIN_PICKER_MIDI + 1 },
  (_, index) => MIN_PICKER_MIDI + index,
);

/** The seven range profile fields, ordered from lowest to highest. */
export const PROFILE_FIELDS: readonly { key: keyof RegisterProfile; label: string }[] = [
  { key: 'limitLow', label: 'Limit (low)' },
  { key: 'comfortLow', label: 'Comfort range (low)' },
  { key: 'preferredLow', label: 'Preferred range (low)' },
  { key: 'center', label: 'Center' },
  { key: 'preferredHigh', label: 'Preferred range (high)' },
  { key: 'comfortHigh', label: 'Comfort range (high)' },
  { key: 'limitHigh', label: 'Limit (high)' },
];

export function isPickerMidi(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_PICKER_MIDI &&
    value <= MAX_PICKER_MIDI
  );
}

/**
 * Checks that all seven profile pitches are within F♯3–C6 and ordered:
 * limitLow <= comfortLow <= preferredLow <= center <= preferredHigh <= comfortHigh <= limitHigh.
 * Returns an error message, or null when the profile is valid.
 */
export function validateProfile(profile: RegisterProfile, naming?: NoteNaming): string | null {
  for (const field of PROFILE_FIELDS) {
    if (!isPickerMidi(profile[field.key])) {
      return `Invalid pitch for ${field.label.toLowerCase()}. Choose a note between ${formatMidiPitch(MIN_PICKER_MIDI, naming)} and ${formatMidiPitch(MAX_PICKER_MIDI, naming)}.`;
    }
  }
  for (let i = 0; i < PROFILE_FIELDS.length - 1; i++) {
    const lower = PROFILE_FIELDS[i]!;
    const upper = PROFILE_FIELDS[i + 1]!;
    if (profile[lower.key] > profile[upper.key]) {
      return `Invalid range: ${lower.label.toLowerCase()} (${formatMidiPitch(profile[lower.key], naming)}) cannot be higher than ${upper.label.toLowerCase()} (${formatMidiPitch(profile[upper.key], naming)}).`;
    }
  }
  return null;
}
