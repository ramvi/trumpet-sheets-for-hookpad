import { AccidentalTracker } from '../model/accidentals';
import type { AccidentalType, NotatedMeasure } from './types';

function alterToAccidental(alter: number): AccidentalType {
  if (alter <= -2) return 'dblflat';
  if (alter === -1) return 'flat';
  if (alter === 0) return 'natural';
  if (alter === 1) return 'sharp';
  return 'dblsharp';
}

export function applyAccidentals(measures: NotatedMeasure[]): void {
  const tracker = new AccidentalTracker();
  for (const measure of measures) {
    tracker.startMeasure(measure.keyFifths);
    for (const element of measure.elements) {
      if (element.kind !== 'note') continue;
      element.printedAccidental = !element.tiedFromPrev && tracker.shouldPrint(element.pitch)
        ? alterToAccidental(element.pitch.alter)
        : null;
    }
  }
}
