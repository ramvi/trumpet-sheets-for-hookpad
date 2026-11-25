import {
  TPQ,
  type KeyChange,
  type Melody,
  type NoteEvent,
  type TupletSpan,
} from '../model/types';
import { ImportError } from './errors';
import type { ImportResult, ImportedVoice, Meter } from './index';
import {
  buildVoices,
  compareVoiceIds,
  normalizeKeys,
  type IntermediateKey,
  type IntermediateNote,
} from './normalize';
import type { RawModernTuplet } from './tuplets';

type ClipFormat = 'modern' | 'legacy';

interface SinglePartResult {
  voices: ImportedVoice[];
  warnings: string[];
  keys: KeyChange[];
}

function invalidJsonError(): ImportError {
  return new ImportError(
    'invalid-json',
    'Invalid JSON. Copy the melody from Hookpad again (Ctrl+C or Cmd+C) and paste the full text.',
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function scanStringEnd(input: string, start: number): number {
  const len = input.length;
  let i = start + 1;
  while (i < len) {
    const ch = input[i]!;
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '"') {
      return i + 1;
    }
    i += 1;
  }
  throw invalidJsonError();
}

function scanCompositeEnd(input: string, start: number): number {
  const len = input.length;
  const stack: string[] = [];
  let i = start;
  while (i < len) {
    const ch = input[i]!;
    if (ch === '"') {
      i = scanStringEnd(input, i);
      continue;
    }
    if (ch === '{') {
      stack.push('}');
    } else if (ch === '[') {
      stack.push(']');
    } else if (ch === '}' || ch === ']') {
      const expected = stack.pop();
      if (expected !== ch) {
        throw invalidJsonError();
      }
      if (stack.length === 0) {
        return i + 1;
      }
    }
    i += 1;
  }
  throw invalidJsonError();
}

function scanPrimitiveEnd(input: string, start: number): number {
  const len = input.length;
  let i = start;
  while (i < len) {
    const ch = input[i]!;
    if (
      /\s/.test(ch) ||
      ch === ',' ||
      ch === '{' ||
      ch === '[' ||
      ch === '}' ||
      ch === ']' ||
      ch === '"'
    ) {
      break;
    }
    i += 1;
  }
  return i;
}

function scanTopLevelJsonValues(input: string): unknown[] {
  const values: unknown[] = [];
  const len = input.length;
  let pos = 0;

  const skipWhitespace = () => {
    while (pos < len && /\s/.test(input[pos]!)) {
      pos += 1;
    }
  };

  skipWhitespace();
  while (pos < len) {
    if (values.length > 0 && input[pos] === ',') {
      pos += 1;
      skipWhitespace();
      if (pos >= len) {
        throw invalidJsonError();
      }
    }

    const start = pos;
    const ch = input[pos]!;
    let end: number;

    if (ch === '{' || ch === '[') {
      end = scanCompositeEnd(input, start);
    } else if (ch === '"') {
      end = scanStringEnd(input, start);
    } else if (ch === '}' || ch === ']' || ch === ',') {
      throw invalidJsonError();
    } else {
      end = scanPrimitiveEnd(input, start);
    }

    const slice = input.slice(start, end);
    let parsed: unknown;
    try {
      parsed = JSON.parse(slice);
    } catch {
      throw invalidJsonError();
    }

    values.push(parsed);
    pos = end;
    skipWhitespace();
  }

  return values;
}

function splitHookpadClips(text: string): unknown[] {
  const cleaned = text.replace(/^\uFEFF/, '').trim();
  if (cleaned.length === 0) {
    throw new ImportError(
      'invalid-json',
      'Paste a melody copied from Hookpad (Ctrl+C or Cmd+C).',
    );
  }

  try {
    const single: unknown = JSON.parse(cleaned);
    if (Array.isArray(single)) {
      if (single.length === 0) {
        throw new ImportError(
          'not-hookpad',
          'This does not look like a Hookpad clip. Select the melody in Hookpad and copy it again.',
        );
      }
      return single;
    }
    return [single];
  } catch (err) {
    if (err instanceof ImportError) {
      throw err;
    }
    return scanTopLevelJsonValues(cleaned);
  }
}

function parseVoiceId(rawVoice: unknown): string {
  if (rawVoice === undefined || rawVoice === null) {
    return '1';
  }
  if (typeof rawVoice === 'number' && Number.isFinite(rawVoice)) {
    return String(rawVoice);
  }
  if (typeof rawVoice === 'string' && rawVoice.trim().length > 0) {
    return rawVoice.trim();
  }
  return '1';
}

const NOTE_FIELDS = {
  modern: ['startTick', 'durationTicks'],
  legacy: ['beat', 'duration'],
} as const;

function hasNoteTiming(
  entry: unknown,
  [positionField, durationField]: readonly [string, string],
): entry is Record<string, unknown> {
  return isRecord(entry) && Number.isFinite(entry[positionField]) && Number.isFinite(entry[durationField]);
}

function looksLikeModernPayload(obj: Record<string, unknown>): boolean {
  if (!Array.isArray(obj['notes'])) return false;
  const notes = obj['notes'];
  if (notes.length > 0) {
    return hasNoteTiming(notes[0], NOTE_FIELDS.modern);
  }
  if (Array.isArray(obj['keys']) && obj['keys'].length > 0) {
    const firstKey = obj['keys'][0];
    if (isRecord(firstKey) && typeof firstKey['startTick'] === 'number') {
      return true;
    }
  }
  return 'baseTick' in obj || 'meters' in obj || 'chords' in obj || 'tempos' in obj;
}

function looksLikeLegacyClip(obj: Record<string, unknown>): boolean {
  if (!Array.isArray(obj['notes'])) return false;
  const notes = obj['notes'];
  if (notes.length > 0) {
    return hasNoteTiming(notes[0], NOTE_FIELDS.legacy);
  }
  return Array.isArray(obj['keys']);
}

function readKeyEntries(rawKeys: unknown, format: ClipFormat): IntermediateKey[] {
  if (!Array.isArray(rawKeys) || rawKeys.length === 0) {
    throw new ImportError(
      'missing-key',
      'The clip has no key signature. Include the key when you copy the melody from Hookpad.',
    );
  }

  return rawKeys.map((key) => {
    if (!isRecord(key)) {
      throw new ImportError(
        'missing-key',
        'The clip contains an invalid key. Copy the melody from Hookpad again.',
      );
    }
    const startTick = Number.isFinite(key['startTick']) ? Math.round(key['startTick'] as number) : undefined;
    const beatTick = Number.isFinite(key['beat']) ? Math.round(((key['beat'] as number) - 1) * TPQ) : undefined;
    const tick = (format === 'modern' ? startTick ?? beatTick : beatTick ?? startTick) ?? 0;
    return { tick, tonic: key['tonic'], scale: key['scale'] };
  });
}

function modernTickOffset(
  payload: Record<string, unknown>,
  rawNotes: readonly Record<string, unknown>[],
  rawKeyEntries: readonly IntermediateKey[],
): number {
  const rawBaseTick =
    typeof payload['baseTick'] === 'number' && Number.isFinite(payload['baseTick'])
      ? Math.round(payload['baseTick'])
      : 0;

  if (rawBaseTick <= 0) return 0;

  const allNotesAtOrAfterBase = rawNotes.every((n) => {
    if (Math.round(n['startTick'] as number) < rawBaseTick) return false;
    const tup = n['tuplet'];
    if (isRecord(tup) && typeof tup['startTick'] === 'number' && Number.isFinite(tup['startTick'])) {
      if (Math.round(tup['startTick']) < rawBaseTick) return false;
    }
    return true;
  });
  const allKeysAtOrAfterBase = rawKeyEntries.every((k) => k.tick >= rawBaseTick);
  return allNotesAtOrAfterBase && allKeysAtOrAfterBase ? rawBaseTick : 0;
}

function readModernNote(n: Record<string, unknown>, tickOffsetToSubtract: number): IntermediateNote {
  const startTick = Math.round(n['startTick'] as number) - tickOffsetToSubtract;
  if (startTick < 0) {
    throw new ImportError(
      'unsupported',
      `A note has an invalid start tick (${String(n['startTick'])}).`,
    );
  }
  const durationTicks = Math.round(n['durationTicks'] as number);
  const isRest = n['isRest'] === true;
  const voiceId = parseVoiceId(n['voice']);
  const rawTuplet = n['tuplet'];
  let tuplet: RawModernTuplet | undefined;
  if (rawTuplet !== undefined && rawTuplet !== null) {
    if (!isRecord(rawTuplet)) {
      throw new ImportError('unsupported', 'The clip contains an invalid tuplet.');
    }
    tuplet = rawTuplet as RawModernTuplet;
  }

  const note: IntermediateNote = {
    tick: startTick,
    durationTicks,
    isRest,
    sd: n['sd'],
    octave: n['octave'],
    voiceId,
  };
  if (tuplet !== undefined) note.tuplet = tuplet;
  return note;
}

function readLegacyNote(n: Record<string, unknown>): IntermediateNote {
  const tick = Math.round(((n['beat'] as number) - 1) * TPQ);
  if (tick < 0) {
    throw new ImportError(
      'unsupported',
      `A note has an invalid beat (${String(n['beat'])}).`,
    );
  }
  const durationTicks = Math.round((n['duration'] as number) * TPQ);
  const isRest = n['isRest'] === true;

  return {
    tick,
    durationTicks,
    isRest,
    sd: n['sd'],
    octave: n['octave'],
    voiceId: '1',
  };
}

function importPart(
  clip: Record<string, unknown>,
  format: ClipFormat,
  allowRestOnly: boolean,
): SinglePartResult {
  const rawNotes = clip['notes'];
  if (!Array.isArray(rawNotes)) {
    throw new ImportError(
      'not-hookpad',
      'The clip has no valid note list. Select the melody in Hookpad and copy it again.',
    );
  }

  const fields = NOTE_FIELDS[format];
  if (!rawNotes.every((note) => hasNoteTiming(note, fields))) {
    throw new ImportError(
      'not-hookpad',
      `The note list has invalid or missing timing fields (${fields.join('/')}). Copy the melody from Hookpad again.`,
    );
  }

  const rawKeys = readKeyEntries(clip['keys'], format);
  const tickOffsetToSubtract = format === 'modern' ? modernTickOffset(clip, rawNotes, rawKeys) : 0;
  const keys = normalizeKeys(rawKeys.map((key) => ({ ...key, tick: key.tick - tickOffsetToSubtract })));
  const warnings: string[] = [];
  const notes = format === 'modern'
    ? rawNotes.map((note) => readModernNote(note, tickOffsetToSubtract))
    : rawNotes.map(readLegacyNote);
  const voices = buildVoices({
    notes, keys, format, tickOffsetToSubtract, warnings, allowRestOnly,
  });

  return { voices, warnings, keys };
}

function importSingleClipValue(parsed: unknown, allowRestOnly: boolean): SinglePartResult {
  if (!isRecord(parsed)) {
    throw new ImportError(
      'not-hookpad',
      'This does not look like a Hookpad clip. Select the melody in Hookpad and copy it again.',
    );
  }

  const modern = parsed['modern'];
  if (isRecord(modern) && isRecord(modern['payload'])) {
    return importPart(modern['payload'], 'modern', allowRestOnly);
  }

  if ('payload' in parsed && isRecord(parsed['payload']) && Array.isArray(parsed['payload']['notes'])) {
    return importPart(parsed['payload'], 'modern', allowRestOnly);
  }

  if (looksLikeModernPayload(parsed)) {
    return importPart(parsed, 'modern', allowRestOnly);
  }

  if (looksLikeLegacyClip(parsed)) {
    return importPart(parsed, 'legacy', allowRestOnly);
  }

  throw new ImportError(
    'not-hookpad',
    'The clip has no valid note list. Select the melody in Hookpad and copy it again.',
  );
}

function sameKey(a: KeyChange, b: KeyChange): boolean {
  return a.tonic.step === b.tonic.step && a.tonic.alter === b.tonic.alter && a.mode === b.mode;
}

function joinParts(parts: readonly SinglePartResult[], beatsPerBar: number): ImportResult {
  if (parts.length === 1) {
    const single = parts[0]!;
    return {
      voices: single.voices,
      warnings: single.warnings,
      parts: 1,
    };
  }

  const combinedKeys: KeyChange[] = [];
  const warnings: string[] = [];
  const voiceEvents = new Map<string, NoteEvent[]>();
  const voiceTuplets = new Map<string, TupletSpan[]>();

  let offset = 0;

  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i]!;
    const partNum = i + 1;
    const isLast = i === parts.length - 1;

    for (const w of part.warnings) {
      warnings.push(`Part ${partNum}: ${w}`);
    }

    const partLocalEndTick = part.voices.reduce((max, v) => Math.max(max, v.melody.endTick), 0);

    const barTicks = beatsPerBar * TPQ;
    const nextOffset = offset + Math.ceil(partLocalEndTick / barTicks) * barTicks;
    if (!isLast && nextOffset !== offset + partLocalEndTick) {
      warnings.push(
        `Part ${partNum}: The clip ended mid-bar. Part ${partNum + 1} starts at the next bar line.`,
      );
    }

    // Skip redundant keys at part boundaries to avoid reprinting the same signature.
    for (let kIdx = 0; kIdx < part.keys.length; kIdx += 1) {
      const k = part.keys[kIdx]!;
      const shiftedTick = k.tick + offset;
      if (!isLast && kIdx > 0 && shiftedTick >= nextOffset) {
        continue;
      }
      const prevKey = combinedKeys[combinedKeys.length - 1];
      if (kIdx === 0 && prevKey && sameKey(prevKey, k)) {
        continue;
      }
      if (prevKey && prevKey.tick === shiftedTick) {
        combinedKeys.pop();
      }
      combinedKeys.push({ ...k, tick: shiftedTick });
    }

    for (const voice of part.voices) {
      let evBucket = voiceEvents.get(voice.id);
      if (!evBucket) {
        evBucket = [];
        voiceEvents.set(voice.id, evBucket);
      }
      for (const ev of voice.melody.events) {
        evBucket.push({ ...ev, tick: ev.tick + offset });
      }

      let tupBucket = voiceTuplets.get(voice.id);
      if (!tupBucket) {
        tupBucket = [];
        voiceTuplets.set(voice.id, tupBucket);
      }
      for (const tup of voice.melody.tuplets) {
        tupBucket.push({ ...tup, startTick: tup.startTick + offset });
      }
    }

    offset = nextOffset;
  }

  const sortedVoiceIds = [...voiceEvents.keys()].sort(compareVoiceIds);
  const voices: ImportedVoice[] = [];

  for (const voiceId of sortedVoiceIds) {
    const events = voiceEvents.get(voiceId)!;
    const onsets = events.reduce((count, ev) => count + (ev.pitch !== null ? 1 : 0), 0);
    if (onsets === 0) {
      continue;
    }

    const rawTuplets = (voiceTuplets.get(voiceId) ?? []).sort(
      (a, b) => a.startTick - b.startTick || a.spanTicks - b.spanTicks,
    );
    const tuplets: TupletSpan[] = [];
    for (const span of rawTuplets) {
      const prev = tuplets[tuplets.length - 1];
      if (prev && span.startTick < prev.startTick + prev.spanTicks) {
        continue;
      }
      tuplets.push(span);
    }

    const endTick = events.reduce((max, ev) => Math.max(max, ev.tick + ev.durationTicks), 0);

    voices.push({
      id: voiceId,
      label: `Voice ${voiceId}`,
      onsets,
      melody: {
        keys: combinedKeys,
        meters: [], // set once, in importHookpad
        tuplets,
        events,
        endTick,
      },
    });
  }

  if (voices.length === 0) {
    throw new ImportError(
      'empty',
      'The clip has no playable notes. Select at least one note in Hookpad and copy it again.',
    );
  }

  return {
    voices,
    warnings,
    parts: parts.length,
  };
}

/**
 * Hookpad stores every beat as 480 ticks, whatever note value the beat is written as.
 * In 6/8 a beat is an eighth note, so its ticks are halved here.
 */
function applyMeter(melody: Melody, meter: Meter): Melody {
  const scale = (tick: number) => Math.round((tick * 4) / meter.denominator);
  const scaleSpan = (start: number, length: number) => scale(start + length) - scale(start);
  return {
    meters: [{ tick: 0, ...meter }],
    keys: melody.keys.map((key) => ({ ...key, tick: scale(key.tick) })),
    tuplets: melody.tuplets.map((t) => ({
      ...t,
      startTick: scale(t.startTick),
      spanTicks: scaleSpan(t.startTick, t.spanTicks),
    })),
    events: melody.events.map((e) => ({
      ...e,
      tick: scale(e.tick),
      durationTicks: scaleSpan(e.tick, e.durationTicks),
    })),
    endTick: scale(melody.endTick),
  };
}

/** Hookpad clips carry no time signature, so the caller supplies it. */
export function importHookpad(
  text: string,
  meter: Meter = { numerator: 4, denominator: 4 },
): ImportResult {
  const rawClips = splitHookpadClips(text);
  const multiPart = rawClips.length > 1;
  const importedParts = rawClips.map((clip, i) => {
    try {
      return importSingleClipValue(clip, multiPart);
    } catch (err) {
      if (multiPart && err instanceof ImportError) {
        throw new ImportError(err.code, `Part ${i + 1}: ${err.message}`);
      }
      throw err;
    }
  });

  const joined = joinParts(importedParts, meter.numerator);
  return {
    ...joined,
    voices: joined.voices.map((voice) => ({ ...voice, melody: applyMeter(voice.melody, meter) })),
  };
}
