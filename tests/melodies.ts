import {
  TPQ,
  type KeyChange,
  type Melody,
  type MeterChange,
  type Mode,
  type NoteEvent,
  type Pitch,
  type PitchClass,
  type Step,
  type TupletSpan,
} from '../src/model/types';

function p(step: Step, octave: number, alter = 0): Pitch {
  return { step, alter, octave };
}

function key(tick: number, step: Step, mode: Mode, alter = 0): KeyChange {
  const tonic: PitchClass = { step, alter };
  return { tick, tonic, mode };
}

function makeMelody(opts: {
  keys: KeyChange[];
  meters?: MeterChange[];
  tuplets?: TupletSpan[];
  events: NoteEvent[];
}): Melody {
  const events = opts.events;
  const endTick = events.reduce((max, ev) => Math.max(max, ev.tick + ev.durationTicks), 0);
  return {
    keys: opts.keys,
    meters: opts.meters ?? [{ tick: 0, numerator: 4, denominator: 4 }],
    tuplets: opts.tuplets ?? [],
    events,
    endTick,
  };
}

export const lowFiveNote: Melody = makeMelody({
  keys: [key(0, 'C', 'major')],
  events: [
    { tick: 0, durationTicks: TPQ, pitch: p('G', 3) },
    { tick: TPQ, durationTicks: TPQ, pitch: p('A', 3) },
    { tick: TPQ * 2, durationTicks: TPQ, pitch: p('B', 3) },
    { tick: TPQ * 3, durationTicks: TPQ, pitch: p('C', 4) },
    { tick: TPQ * 4, durationTicks: TPQ, pitch: p('D', 4) },
  ],
});

export const wideMelody: Melody = makeMelody({
  keys: [key(0, 'G', 'major')],
  events: [
    { tick: 0, durationTicks: TPQ, pitch: p('F', 3, 1) },
    { tick: TPQ, durationTicks: TPQ, pitch: p('G', 3) },
    { tick: TPQ * 2, durationTicks: TPQ, pitch: p('D', 4) },
    { tick: TPQ * 3, durationTicks: TPQ, pitch: p('B', 4) },
    { tick: TPQ * 4, durationTicks: TPQ, pitch: p('E', 5) },
    { tick: TPQ * 5, durationTicks: TPQ, pitch: p('G', 4) },
  ],
});

export const withRestsAndGap: Melody = makeMelody({
  keys: [key(0, 'C', 'major')],
  events: [
    { tick: 0, durationTicks: TPQ, pitch: p('C', 4) },
    { tick: TPQ, durationTicks: TPQ, pitch: null },
    { tick: TPQ * 2, durationTicks: TPQ, pitch: p('E', 4) },
    { tick: TPQ * 4, durationTicks: TPQ, pitch: p('G', 4) },
    { tick: TPQ * 5, durationTicks: TPQ, pitch: p('C', 5) },
  ],
});

export const withKeyChange: Melody = makeMelody({
  keys: [key(0, 'C', 'major'), key(TPQ * 8, 'A', 'major', -1)],
  events: [
    { tick: 0, durationTicks: TPQ, pitch: p('C', 4) },
    { tick: TPQ, durationTicks: TPQ, pitch: p('D', 4) },
    { tick: TPQ * 2, durationTicks: TPQ, pitch: p('E', 4) },
    { tick: TPQ * 3, durationTicks: TPQ, pitch: p('F', 4) },
    { tick: TPQ * 4, durationTicks: TPQ * 2, pitch: p('G', 4) },
    { tick: TPQ * 6, durationTicks: TPQ * 2, pitch: p('E', 4) },
    { tick: TPQ * 8, durationTicks: TPQ, pitch: p('A', 4, -1) },
    { tick: TPQ * 9, durationTicks: TPQ, pitch: p('B', 4, -1) },
    { tick: TPQ * 10, durationTicks: TPQ, pitch: p('C', 5) },
    { tick: TPQ * 11, durationTicks: TPQ, pitch: p('D', 5, -1) },
    { tick: TPQ * 12, durationTicks: TPQ * 2, pitch: p('E', 5, -1) },
    { tick: TPQ * 14, durationTicks: TPQ * 2, pitch: p('A', 4, -1) },
  ],
});

export const tieAndTriplet: Melody = makeMelody({
  keys: [key(0, 'C', 'major')],
  tuplets: [{ startTick: TPQ * 5, spanTicks: TPQ, actual: 3, normal: 2 }],
  events: [
    { tick: 0, durationTicks: TPQ * 2, pitch: p('C', 4) },
    { tick: TPQ * 2, durationTicks: TPQ * 3, pitch: p('E', 4) },
    { tick: TPQ * 5, durationTicks: 160, pitch: p('G', 4) },
    { tick: TPQ * 5 + 160, durationTicks: 160, pitch: p('A', 4) },
    { tick: TPQ * 5 + 320, durationTicks: 160, pitch: p('B', 4) },
    { tick: TPQ * 6, durationTicks: TPQ * 2, pitch: p('C', 5) },
  ],
});

/** Expected import of `fixtures/reference-written.json`, written out by hand as pitch:ticks (r = rest). */
const REFERENCE = `
  G3:480 Eb4:240 D4:240 C4:960
  D4:480 F4:720 Eb4:240 D4:480
  G4:160 F4:160 Eb4:160 C5:1200 Bb4:240
  Ab4:1280 G4:160 F4:240 Eb4:240
  Eb4:320 F4:320 G4:320 Cb5:480 Bb4:480
  C5:480 Eb5:480 r:480 D5:480
  C5:120 Bb4:120 Ab4:120 A4:120 G4:240 G4:240 G4:240 G4:240 G3:480
  B4:2400 C4:1440`;

function parseEvents(text: string): NoteEvent[] {
  let tick = 0;
  return text.trim().split(/\s+/).map((token) => {
    const [, step, flat, octave, ticks] = /^([A-Gr])(b?)(\d?):(\d+)$/.exec(token)!;
    const pitch = step === 'r' ? null : p(step as Step, Number(octave), flat ? -1 : 0);
    const event = { tick, durationTicks: Number(ticks), pitch };
    tick += event.durationTicks;
    return event;
  });
}

export const referenceMelody: Melody = makeMelody({
  keys: [key(0, 'C', 'minor')],
  tuplets: [
    { startTick: 3840, spanTicks: 480, actual: 3, normal: 2 },
    { startTick: 6720, spanTicks: 480, actual: 3, normal: 2 },
    { startTick: 7680, spanTicks: 960, actual: 3, normal: 2 },
  ],
  events: parseEvents(REFERENCE),
});
