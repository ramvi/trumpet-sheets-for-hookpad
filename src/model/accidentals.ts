import { keySignatureAlter } from './pitch';
import type { Pitch } from './types';

export class AccidentalTracker {
  private keyFifths = 0;
  private bar = new Map<string, number>();
  private previousBar: ReadonlyMap<string, number> | undefined;

  startMeasure(keyFifths: number, consecutive = true): void {
    this.previousBar = consecutive && keyFifths === this.keyFifths ? this.bar : undefined;
    this.bar = new Map();
    this.keyFifths = keyFifths;
  }

  shouldPrint(pitch: Pitch): boolean {
    const position = `${pitch.step}${pitch.octave}`;
    const keyAlter = keySignatureAlter(this.keyFifths, pitch.step);
    const barAlter = this.bar.get(position);
    const previousAlter = this.previousBar?.get(position);
    this.bar.set(position, pitch.alter);

    // A courtesy accidental recalls the key signature after an alteration in the previous bar.
    return pitch.alter !== (barAlter ?? keyAlter) ||
      (barAlter === undefined && previousAlter !== undefined && previousAlter !== keyAlter);
  }
}
