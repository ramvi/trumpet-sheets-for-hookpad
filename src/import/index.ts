import type { Melody, MeterChange } from '../model/types';

export { ImportError } from './errors';
export { importHookpad } from './multi';

export interface ImportedVoice {
  id: string;
  label: string;
  melody: Melody;
  onsets: number;
}

export interface ImportResult {
  voices: ImportedVoice[];
  warnings: string[];
  parts: number;
}

export type Meter = Pick<MeterChange, 'numerator' | 'denominator'>;
