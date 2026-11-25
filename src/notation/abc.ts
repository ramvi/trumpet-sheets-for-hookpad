import type { Pitch } from '../model/types';
import type {
  AccidentalType,
  NotatedElement,
  NotatedMeasure,
  NotatedNote,
  NotatedSystem,
} from './types';

const ABC_KEY_BY_FIFTHS: Record<number, string> = {
  [-7]: 'Cb',
  [-6]: 'Gb',
  [-5]: 'Db',
  [-4]: 'Ab',
  [-3]: 'Eb',
  [-2]: 'Bb',
  [-1]: 'F',
  [0]: 'C',
  [1]: 'G',
  [2]: 'D',
  [3]: 'A',
  [4]: 'E',
  [5]: 'B',
  [6]: 'F#',
  [7]: 'C#',
};

const ABC_ACCIDENTAL: Record<AccidentalType, string> = {
  dblflat: '__',
  flat: '_',
  natural: '=',
  sharp: '^',
  dblsharp: '^^',
};

const ABC_UNIT_TICKS = 240;

function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y !== 0) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x || 1;
}

function keyFifthsToAbc(fifths: number): string {
  return ABC_KEY_BY_FIFTHS[fifths] ?? 'C';
}

function pitchToAbc(pitch: Pitch, accidental: AccidentalType | null): string {
  const acc = accidental ? ABC_ACCIDENTAL[accidental] : '';
  if (pitch.octave >= 5) {
    const base = pitch.step.toLowerCase();
    const apostrophes = "'".repeat(pitch.octave - 5);
    return `${acc}${base}${apostrophes}`;
  }
  const base = pitch.step.toUpperCase();
  const commas = ','.repeat(4 - pitch.octave);
  return `${acc}${base}${commas}`;
}

function durationToAbc(writtenTicks: number): string {
  const ticks = Math.round(writtenTicks);
  const g = gcd(ticks, ABC_UNIT_TICKS);
  const num = ticks / g;
  const den = ABC_UNIT_TICKS / g;
  if (den === 1) {
    return num === 1 ? '' : String(num);
  }
  if (num === 1) {
    return `/${den}`;
  }
  return `${num}/${den}`;
}

function isBeamable(el: NotatedElement): el is NotatedNote {
  return el.kind === 'note' && el.writtenTicks < 480;
}

function escapeAbcLyric(text: string): string {
  return text.replace(/([ \-_*\|\~])/g, (ch) => (ch === ' ' ? '~' : `\\${ch}`));
}

function renderMeasureAbc(
  measure: NotatedMeasure,
  isLastMeasure: boolean,
): { music: string; lyricTokens: string[] } {
  const parts: string[] = [];
  const lyricTokens: string[] = [];

  if (measure.hasKeyChange) {
    parts.push(`[K:${keyFifthsToAbc(measure.keyFifths)}]`);
  }
  if (measure.hasMeterChange) {
    parts.push(`[M:${measure.meter.numerator}/${measure.meter.denominator}]`);
  }

  let currentChunk = '';
  const flushChunk = () => {
    if (currentChunk.length > 0) {
      parts.push(currentChunk);
      currentChunk = '';
    }
  };

  for (let i = 0; i < measure.elements.length; i++) {
    const el = measure.elements[i]!;
    const prev = i > 0 ? measure.elements[i - 1]! : null;

    const prevWasTieIntoThis =
      prev !== null && prev.kind === 'note' && prev.tiedToNext && el.kind === 'note' && el.tiedFromPrev;

    const sameTuplet =
      prev !== null &&
      prev.tuplet !== null &&
      el.tuplet !== null &&
      prev.tuplet.groupId === el.tuplet.groupId;

    const canBeamWithPrev =
      prev !== null &&
      isBeamable(prev) &&
      isBeamable(el) &&
      (sameTuplet || (prev.tuplet === null && el.tuplet === null && prev.beamGroup === el.beamGroup));

    // Keep tie tokens glued (`G4-G` or `c4-(3:2:2c2c`) so abcjs renders the tie cleanly,
    // and glue beamable notes in the same beat/tuplet.
    if (i > 0 && !canBeamWithPrev && !prevWasTieIntoThis) {
      flushChunk();
    }

    if (el.tuplet && el.tuplet.isStart) {
      const { actual, normal, itemCount } = el.tuplet;
      if (actual === 3 && normal === 2 && itemCount === 3) {
        currentChunk += '(3';
      } else {
        currentChunk += `(${actual}:${normal}:${itemCount}`;
      }
    }

    if (el.kind === 'note') {
      const note: NotatedNote = el;
      const pitchStr = pitchToAbc(note.pitch, note.printedAccidental);
      const durStr = durationToAbc(note.writtenTicks);
      const tieStr = note.tiedToNext ? '-' : '';
      currentChunk += `${pitchStr}${durStr}${tieStr}`;
      lyricTokens.push(note.fingering !== null ? escapeAbcLyric(note.fingering) : '*');
    } else {
      const durStr = durationToAbc(el.writtenTicks);
      currentChunk += `z${durStr}`;
      // Emit '*' for every rest so abcjs's addWords stays 1:1 synchronized (in abcjs, '*' consumes rests).
      lyricTokens.push('*');
    }
  }

  flushChunk();

  const barline = isLastMeasure ? '|]' : '|';
  return {
    music: `${parts.join(' ')} ${barline}`,
    lyricTokens,
  };
}

/**
 * Generates the complete ABC notation string for a layout of systems.
 * Uses explicit line breaks so each system maps 1:1 to a rendered SVG line (`oneSvgPerLine: true`).
 */
export function generateAbc(systems: NotatedSystem[]): string {
  if (systems.length === 0 || systems[0]!.measures.length === 0) {
    return 'X:1\nM:4/4\nL:1/8\nK:C\nz8 |]\n';
  }

  const firstMeasure = systems[0]!.measures[0]!;
  const totalMeasures = systems.reduce((sum, sys) => sum + sys.measures.length, 0);

  // Stretch last line when there are multiple systems and the last system has >= 2 bars (or high fill)
  const lastSys = systems[systems.length - 1]!;
  const stretchLast = systems.length > 1 && lastSys.measures.length >= 2 ? 0.55 : 0.75;

  const lines: string[] = [
    '%%vocalfont Helvetica 10.5',
    '%%vocalspace 10',
    '%%staffsep 46',
    `%%stretchlast ${stretchLast}`,
    'X:1',
    `M:${firstMeasure.meter.numerator}/${firstMeasure.meter.denominator}`,
    'L:1/8',
    `K:${keyFifthsToAbc(firstMeasure.keyFifths)}`,
  ];

  let measureCounter = 0;
  for (const sys of systems) {
    const barStrings: string[] = [];
    const lyricBars: string[] = [];

    for (const measure of sys.measures) {
      measureCounter++;
      const isLast = measureCounter === totalMeasures;
      const rendered = renderMeasureAbc(measure, isLast);
      barStrings.push(rendered.music);
      lyricBars.push(rendered.lyricTokens.join(' '));
    }

    lines.push(barStrings.join(' '));
    if (sys.hasFingerings) {
      lines.push(`w: ${lyricBars.join(' | ')}`);
    }
  }

  return `${lines.join('\n')}\n`;
}
