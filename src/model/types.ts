export const TPQ = 480 as const;

export type Step = 'C' | 'D' | 'E' | 'F' | 'G' | 'A' | 'B';

/** Spelled pitch class. alter = semitones away from the natural letter: -2 𝄫, -1 ♭, 0 ♮, +1 ♯, +2 𝄪. */
export interface PitchClass { step: Step; alter: number; }

/** Spelled pitch. `octave` is scientific and belongs to the LETTER:
 *  C4 = middle C = MIDI 60; C♭5 has octave 5 and MIDI 71; B♯3 has octave 3 and MIDI 60.
 *  Spelling and sounding height are deliberately separate: use pitchToMidi() for height. */
export interface Pitch extends PitchClass { octave: number; }

export type Mode = 'major' | 'dorian' | 'phrygian' | 'lydian' | 'mixolydian' | 'minor' | 'locrian' | 'harmonicMinor' | 'phrygianDominant';

export interface KeyChange { tick: number; tonic: PitchClass; mode: Mode; }
export interface MeterChange { tick: number; numerator: number; denominator: number; }
export interface TupletSpan { startTick: number; spanTicks: number; actual: number; normal: number; }
/** One event = one attack (onset) when pitch != null, or an explicit rest when pitch == null.
 *  Gaps between events are implicit rests. Events are sorted by tick and never overlap (monophonic). */
export interface NoteEvent { tick: number; durationTicks: number; pitch: Pitch | null; }

export interface Melody {
  keys: KeyChange[];        // >= 1 entry, sorted, first at tick 0
  meters: MeterChange[];    // >= 1 entry, sorted, first at tick 0
  tuplets: TupletSpan[];    // sorted, non-overlapping
  events: NoteEvent[];
  endTick: number;          // end of the last event
}
