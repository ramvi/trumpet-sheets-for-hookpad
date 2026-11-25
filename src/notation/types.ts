import type { MeterChange, Pitch } from '../model/types';

export type FingeringRepeat = 'every' | 'first-in-run';

export interface NotationOptions {
  title?: string;
  fingeringLabel?: (pitch: Pitch) => string | null;
  fingeringRepeat?: FingeringRepeat;
}

export interface ScoreStats {
  measures: number;
  onsets: number;
  noteheads: number;
  tupletGroups: number;
  ties: number;
  fingeringLabels: number;
}

export type AccidentalType = 'dblflat' | 'flat' | 'natural' | 'sharp' | 'dblsharp';

export interface TupletInfo {
  groupId: number;
  actual: number;
  normal: number;
  itemCount: number;
  isStart: boolean;
  isEnd: boolean;
}

export interface NotatedNote {
  kind: 'note';
  startTick: number;
  soundingTicks: number;
  /** Written (notated) duration in ticks (equals soundingTicks outside tuplets; scaled by actual/normal inside tuplets). */
  writtenTicks: number;
  pitch: Pitch;
  isOnset: boolean;
  /** Stable identifier linking all tied pieces of the same NoteEvent. */
  onsetIndex: number;
  tiedFromPrev: boolean;
  tiedToNext: boolean;
  printedAccidental: AccidentalType | null;
  fingering: string | null;
  tuplet: TupletInfo | null;
  /** Beat index within the measure (used for beat-level beaming). */
  beamGroup: number;
}

export interface NotatedRest {
  kind: 'rest';
  startTick: number;
  soundingTicks: number;
  writtenTicks: number;
  tuplet: TupletInfo | null;
}

export type NotatedElement = NotatedNote | NotatedRest;

export interface NotatedMeasure {
  meter: MeterChange;
  hasMeterChange: boolean;
  keyFifths: number;
  hasKeyChange: boolean;
  elements: NotatedElement[];
}

export interface NotatedSystem {
  measures: NotatedMeasure[];
  hasFingerings: boolean;
}

export interface NotatedScore {
  stats: ScoreStats;
  title: string;
  measures: NotatedMeasure[];
  systems: NotatedSystem[];
  abc: string;
}
