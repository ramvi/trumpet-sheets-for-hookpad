import { keySignatureFifths } from './pitch';
import { TPQ, type KeyChange, type MeterChange } from './types';

export interface MeasureSpan {
  startTick: number;
  endTick: number;
  meter: MeterChange;
  keyFifths: number;
}

function printedKeyFifths(key: KeyChange): number {
  let fifths = keySignatureFifths(key.tonic, key.mode);
  while (fifths > 7) fifths -= 12;
  while (fifths < -7) fifths += 12;
  return fifths;
}

// A forward cursor lets ranking skip empty measures without losing bar-line positions.
export function createMeasureCursor(
  keys: readonly KeyChange[],
  meters: readonly MeterChange[],
): (tick: number) => MeasureSpan {
  let meterIndex = 0;
  let keyIndex = 0;
  let current: MeasureSpan | undefined;

  return (tick) => {
    if (current && tick >= current.startTick && tick < current.endTick) return current;

    while (meterIndex + 1 < meters.length && meters[meterIndex + 1]!.tick <= tick) {
      meterIndex++;
    }
    const meter = meters[meterIndex]!;
    const meterStart = meterIndex === 0 ? 0 : meter.tick;
    const measureTicks = Math.round((meter.numerator * TPQ * 4) / meter.denominator);
    const startTick = meterStart + Math.floor((tick - meterStart) / measureTicks) * measureTicks;
    const endTick = Math.min(startTick + measureTicks, meters[meterIndex + 1]?.tick ?? Infinity);

    while (keyIndex + 1 < keys.length && keys[keyIndex + 1]!.tick <= startTick) {
      keyIndex++;
    }
    const key = keys[keyIndex];
    current = { startTick, endTick, meter, keyFifths: key ? printedKeyFifths(key) : 0 };
    return current;
  };
}
