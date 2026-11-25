import type { Pitch } from '../model/types';
import { pitchToMidi } from '../model/pitch';

/**
 * The Yamaha B♭-trumpet chart is indexed by MIDI height so enharmonic spellings share fingerings.
 */
const FINGERING_BY_MIDI: Readonly<Record<number, string>> = {
  54: '1+2+3', // F♯3 / G♭3
  55: '1+3', // G3
  56: '2+3', // G♯3 / A♭3
  57: '1+2', // A3
  58: '1', // A♯3 / B♭3
  59: '2', // B3
  60: '0', // C4
  61: '1+2+3', // C♯4 / D♭4
  62: '1+3', // D4
  63: '2+3', // D♯4 / E♭4
  64: '1+2', // E4
  65: '1', // F4
  66: '2', // F♯4 / G♭4
  67: '0', // G4
  68: '2+3', // G♯4 / A♭4
  69: '1+2', // A4
  70: '1', // A♯4 / B♭4
  71: '2', // B4
  72: '0', // C5
  73: '1+2', // C♯5 / D♭5
  74: '1', // D5
  75: '2', // D♯5 / E♭5
  76: '0', // E5
  77: '1', // F5
  78: '2', // F♯5 / G♭5
  79: '0', // G5
  80: '2+3', // G♯5 / A♭5
  81: '1+2', // A5
  82: '1', // A♯5 / B♭5
  83: '2', // B5
  84: '0', // C6
};

/**
 * Awkward valve combinations that involve the third valve (ring finger) and often
 * require slide adjustment for intonation: "2+3", "1+3", and "1+2+3".
 */
const DEMANDING_FINGERINGS: ReadonlySet<string> = new Set(['2+3', '1+3', '1+2+3']);

export function fingeringFor(pitch: Pitch): string | null {
  const midi = pitchToMidi(pitch);
  return FINGERING_BY_MIDI[midi] ?? null;
}

/** Players know the plain naturals C4–C5 by heart; everything else gets a printed fingering. */
export function needsFingering(pitch: Pitch): boolean {
  if (pitch.alter !== 0) return true;
  const midi = pitchToMidi(pitch);
  return midi < 60 || midi > 72;
}

export function fingeringLabel(pitch: Pitch): string | null {
  return needsFingering(pitch) ? fingeringFor(pitch) : null;
}

export function isDemandingFingering(pitch: Pitch): boolean {
  const fingering = fingeringFor(pitch);
  return fingering !== null && DEMANDING_FINGERINGS.has(fingering);
}
