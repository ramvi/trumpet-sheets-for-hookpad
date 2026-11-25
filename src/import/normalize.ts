import { pitchToMidi } from '../model/pitch';
import type { KeyChange, NoteEvent, Pitch, TupletSpan } from '../model/types';
import { ImportError } from './errors';
import type { ImportedVoice } from './index';
import { parseMode, parseTonic, resolveScaleDegreePitch } from './pitch';
import { extractModernTuplets, inferLegacyTuplets, type RawModernTuplet } from './tuplets';

export interface IntermediateNote {
  tick: number;
  durationTicks: number;
  isRest: boolean;
  sd: unknown;
  octave: unknown;
  voiceId: string;
  tuplet?: RawModernTuplet;
}

export interface IntermediateKey {
  tick: number;
  tonic: unknown;
  scale: unknown;
}

export function normalizeKeys(rawKeys: readonly IntermediateKey[]): KeyChange[] {
  const parsed: KeyChange[] = rawKeys.map((k) => ({
    tick: k.tick,
    tonic: parseTonic(k.tonic),
    mode: parseMode(k.scale),
  }));

  parsed.sort((a, b) => a.tick - b.tick);

  const deduped: KeyChange[] = [];
  for (const key of parsed) {
    const clampedTick = Math.max(0, key.tick);
    const prev = deduped[deduped.length - 1];
    if (prev && prev.tick === clampedTick) {
      deduped[deduped.length - 1] = { ...key, tick: clampedTick };
    } else {
      deduped.push({ ...key, tick: clampedTick });
    }
  }

  if (deduped[0]!.tick > 0) {
    deduped[0] = { ...deduped[0]!, tick: 0 };
  }

  return deduped;
}

function activeKeyAt(keys: readonly KeyChange[], noteTick: number): KeyChange {
  let active = keys[0]!;
  for (let i = 1; i < keys.length; i += 1) {
    const candidate = keys[i]!;
    if (candidate.tick <= noteTick) {
      active = candidate;
    } else {
      break;
    }
  }
  return active;
}

function parseOctaveOffset(rawOctave: unknown): number {
  if (rawOctave === undefined || rawOctave === null) {
    return 0;
  }
  if (typeof rawOctave !== 'number' || !Number.isInteger(rawOctave)) {
    throw new ImportError(
      'unsupported',
      `A note has an invalid octave offset ("${String(rawOctave)}").`,
    );
  }
  return rawOctave;
}

export function compareVoiceIds(a: string, b: string): number {
  const numA = Number(a);
  const numB = Number(b);
  const aIsNum = Number.isFinite(numA) && String(numA) === a;
  const bIsNum = Number.isFinite(numB) && String(numB) === b;
  if (aIsNum && bIsNum) return numA - numB;
  if (aIsNum) return -1;
  if (bIsNum) return 1;
  return a.localeCompare(b);
}

interface ResolvedEventWithMeta {
  event: NoteEvent;
  tuplet?: RawModernTuplet;
}

export function buildVoices(params: {
  notes: readonly IntermediateNote[];
  keys: KeyChange[];
  format: 'modern' | 'legacy';
  tickOffsetToSubtract: number;
  warnings: string[];
  allowRestOnly?: boolean;
}): ImportedVoice[] {
  const {
    notes,
    keys,
    format,
    tickOffsetToSubtract,
    warnings,
    allowRestOnly = false,
  } = params;

  const byVoice = new Map<string, IntermediateNote[]>();
  for (const note of notes) {
    let bucket = byVoice.get(note.voiceId);
    if (!bucket) {
      bucket = [];
      byVoice.set(note.voiceId, bucket);
    }
    bucket.push(note);
  }

  const sortedVoiceIds = [...byVoice.keys()].sort(compareVoiceIds);
  const multiVoice = sortedVoiceIds.length > 1;
  const voices: ImportedVoice[] = [];

  for (const voiceId of sortedVoiceIds) {
    const voicePrefix = multiVoice ? `Voice ${voiceId}: ` : '';
    const voiceNotes = byVoice.get(voiceId)!;

    const resolved: ResolvedEventWithMeta[] = [];
    let skippedNonPositiveDuration = 0;

    for (const raw of voiceNotes) {
      if (raw.durationTicks <= 0) {
        skippedNonPositiveDuration += 1;
        continue;
      }

      let pitch: Pitch | null = null;
      if (!raw.isRest) {
        const key = activeKeyAt(keys, raw.tick);
        const octaveOffset = parseOctaveOffset(raw.octave);
        pitch = resolveScaleDegreePitch(raw.sd, octaveOffset, key);
      }

      const event: NoteEvent =
        { tick: raw.tick, durationTicks: raw.durationTicks, pitch };

      resolved.push(raw.tuplet !== undefined ? { event, tuplet: raw.tuplet } : { event });
    }

    if (skippedNonPositiveDuration > 0) {
      warnings.push(
        `${voicePrefix}Skipped ${skippedNonPositiveDuration} note${skippedNonPositiveDuration === 1 ? '' : 's'} with a duration of zero or less.`,
      );
    }

    resolved.sort((a, b) => a.event.tick - b.event.tick);

    // When chord notes share an onset, keep the top line.
    const deduped: ResolvedEventWithMeta[] = [];
    let sameTickCollisions = 0;

    for (const item of resolved) {
      const prev = deduped[deduped.length - 1];
      if (!prev || prev.event.tick !== item.event.tick) {
        deduped.push(item);
        continue;
      }

      const prevPitch = prev.event.pitch;
      const currPitch = item.event.pitch;

      if (prevPitch !== null && currPitch !== null) {
        sameTickCollisions += 1;
        const prevMidi = pitchToMidi(prevPitch);
        const currMidi = pitchToMidi(currPitch);
        if (currMidi > prevMidi || (currMidi === prevMidi && item.event.durationTicks > prev.event.durationTicks)) {
          deduped[deduped.length - 1] = {
            event: item.event,
            tuplet: item.tuplet ?? prev.tuplet,
          };
        } else if (prev.tuplet === undefined && item.tuplet !== undefined) {
          deduped[deduped.length - 1] = {
            event: prev.event,
            tuplet: item.tuplet,
          };
        }
      } else if (prevPitch === null && currPitch !== null) {
        deduped[deduped.length - 1] = {
          event: item.event,
          tuplet: item.tuplet ?? prev.tuplet,
        };
      } else if (prevPitch === null && currPitch === null) {
        if (item.event.durationTicks > prev.event.durationTicks) {
          deduped[deduped.length - 1] = {
            event: item.event,
            tuplet: item.tuplet ?? prev.tuplet,
          };
        }
      }
    }

    if (sameTickCollisions > 0) {
      warnings.push(
        `${voicePrefix}Removed ${sameTickCollisions} simultaneous note${sameTickCollisions === 1 ? '' : 's'} and kept the highest pitch at each onset.`,
      );
    }

    const events: NoteEvent[] = deduped.map((item) => ({ ...item.event }));
    let overlappedNotes = 0;

    for (let i = 0; i < events.length - 1; i += 1) {
      const curr = events[i]!;
      const next = events[i + 1]!;
      if (curr.tick + curr.durationTicks > next.tick) {
        curr.durationTicks = next.tick - curr.tick;
        if (curr.pitch !== null) {
          overlappedNotes += 1;
        }
      }
    }

    if (overlappedNotes > 0) {
      warnings.push(
        `${voicePrefix}Shortened ${overlappedNotes} note${overlappedNotes === 1 ? '' : 's'} that overlapped the next note.`,
      );
    }

    const onsets = events.reduce((count, ev) => count + (ev.pitch !== null ? 1 : 0), 0);
    if (onsets === 0 && (!allowRestOnly || events.length === 0)) {
      continue;
    }

    const tuplets: TupletSpan[] =
      format === 'modern'
        ? extractModernTuplets(
            deduped.map((d) => d.tuplet).filter((t): t is RawModernTuplet => t !== undefined),
            tickOffsetToSubtract,
            warnings,
            voicePrefix,
          )
        : inferLegacyTuplets(events);

    const endTick = events.reduce((max, ev) => Math.max(max, ev.tick + ev.durationTicks), 0);

    voices.push({
      id: voiceId,
      label: `Voice ${voiceId}`,
      onsets,
      melody: {
        keys: keys.map((k) => ({ tick: k.tick, tonic: { ...k.tonic }, mode: k.mode })),
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

  return voices;
}
