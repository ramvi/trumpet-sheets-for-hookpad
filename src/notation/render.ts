import { renderAbc } from 'abcjs';
import { pitchToMidi } from '../model/pitch';
import type { Melody, Pitch } from '../model/types';
import { applyAccidentals } from './accidentals';
import { generateAbc } from './abc';
import { layoutSystems, TARGET_SYSTEM_WEIGHT } from './layout';
import { buildMeasuresWithRhythm } from './rhythm';
import type {
  FingeringRepeat,
  NotatedMeasure,
  NotatedScore,
  NotatedSystem,
  NotationOptions,
  ScoreStats,
} from './types';

/**
 * Applies fingering labels across `systems` according to `fingeringRepeat`:
 * - `'every'`: every onset gets `fingeringLabel(pitch)`.
 * - `'first-in-run'`: a qualifying onset gets its label unless the immediately preceding
 *   onset had the same sounding MIDI pitch, with no rest (explicit or implicit gap) in
 *   between, and lies on the same system.
 * Tied continuations never get labels. Updates `sys.hasFingerings` on each system and
 * returns the total number of printed labels.
 */
function applyFingeringToSystems(
  systems: NotatedSystem[],
  fingeringLabel: ((pitch: Pitch) => string | null) | undefined,
  fingeringRepeat: FingeringRepeat,
): number {
  let printed = 0;

  for (const sys of systems) {
    let prevAttackMidi: number | null = null;
    let sysHasFingerings = false;

    for (const measure of sys.measures) {
      for (const el of measure.elements) {
        if (el.kind === 'rest') {
          prevAttackMidi = null;
          continue;
        }

        if (!el.isOnset) {
          el.fingering = null;
          continue;
        }

        const midi = pitchToMidi(el.pitch);
        const raw = fingeringLabel ? fingeringLabel(el.pitch) : null;

        if (raw !== null && (fingeringRepeat === 'every' || prevAttackMidi !== midi)) {
          el.fingering = raw;
          printed++;
          sysHasFingerings = true;
        } else {
          el.fingering = null;
        }

        prevAttackMidi = midi;
      }
    }

    sys.hasFingerings = sysHasFingerings;
  }

  return printed;
}

/**
 * Computes a system layout consistent with the final printed fingering labels.
 * In `'first-in-run'` mode, repeated labels are suppressed before layout so bars do not
 * reserve width for unprinted labels; labels restored at system boundaries are then fed
 * back until the layout converges.
 */
function layoutWithFingerings(
  measures: NotatedMeasure[],
  fingeringLabel: ((pitch: Pitch) => string | null) | undefined,
  fingeringRepeat: FingeringRepeat,
  measureWeightBoosts?: readonly number[],
): { systems: NotatedSystem[]; fingeringLabels: number } {
  if (fingeringRepeat === 'every' || !fingeringLabel) {
    const systems = layoutSystems(measures, measureWeightBoosts);
    const fingeringLabels = applyFingeringToSystems(systems, fingeringLabel, 'every');
    return { systems, fingeringLabels };
  }

  applyFingeringToSystems(
    [{ measures, hasFingerings: false }],
    fingeringLabel,
    'first-in-run',
  );

  let systems = layoutSystems(measures, measureWeightBoosts);
  let prevKey = systems.map((s) => s.measures.length).join(',');
  let fingeringLabels = applyFingeringToSystems(systems, fingeringLabel, 'first-in-run');

  // Re-layout if any label restored at a system start changes system breaks (fixed-point, max 4 passes).
  for (let iter = 0; iter < 4; iter++) {
    const nextSystems = layoutSystems(measures, measureWeightBoosts);
    const nextKey = nextSystems.map((s) => s.measures.length).join(',');
    if (nextKey === prevKey) {
      systems = nextSystems;
      fingeringLabels = applyFingeringToSystems(systems, fingeringLabel, 'first-in-run');
      break;
    }
    prevKey = nextKey;
    systems = nextSystems;
    fingeringLabels = applyFingeringToSystems(systems, fingeringLabel, 'first-in-run');
  }

  return { systems, fingeringLabels };
}

export function buildNotation(melody: Melody, opts?: NotationOptions): NotatedScore {
  const title = (opts?.title ?? '').trim();
  const fingeringRepeat: FingeringRepeat = opts?.fingeringRepeat ?? 'every';
  const { measures, stats } = buildMeasuresWithRhythm(melody, opts?.fingeringLabel);
  applyAccidentals(measures);
  const { systems, fingeringLabels } = layoutWithFingerings(
    measures,
    opts?.fingeringLabel,
    fingeringRepeat,
  );
  const abc = generateAbc(systems);

  return {
    stats: {
      ...stats,
      fingeringLabels,
    },
    title,
    measures,
    systems,
    abc,
  };
}

const MIN_LABEL_GAP_SVG_UNITS = 2.5;
const MIN_LABEL_GAP_BELOW_STAFF = 7.5;
const MIN_LABEL_GAP_BELOW_ELEMENT = 4.5;
const VIEWBOX_TOP_PAD = 3;
const VIEWBOX_BOTTOM_PAD = 3;

interface SystemPostProcessResult {
  hasLabelCollision: boolean;
  worstRequiredScale: number;
}

function setLyricX(el: SVGTextElement, x: number): void {
  const formatted = x.toFixed(2);
  el.setAttribute('text-anchor', 'middle');
  el.setAttribute('x', formatted);
  for (const tspan of Array.from(el.querySelectorAll('tspan'))) {
    tspan.setAttribute('x', formatted);
  }
}

function centerLyricOnNotehead(el: SVGTextElement): void {
  // Remove empty trailing <tspan dy="1.2em"></tspan> that abcjs emits on lyrics
  for (const tspan of Array.from(el.querySelectorAll('tspan'))) {
    const txt = (tspan.textContent ?? '').replace(/\u00a0/g, '').trim();
    if (txt.length === 0) {
      tspan.remove();
    }
  }

  const noteGroup = el.closest('.abcjs-note');
  const notehead = noteGroup?.querySelector<SVGGraphicsElement>('.abcjs-notehead');
  if (!notehead || typeof notehead.getBBox !== 'function' || typeof el.getBBox !== 'function') {
    return;
  }

  const headBox = notehead.getBBox();
  if (headBox.width <= 0) {
    return;
  }

  const targetCenterX = headBox.x + headBox.width / 2;
  setLyricX(el, targetCenterX);

  const afterBox = el.getBBox();
  if (afterBox.width > 0) {
    const actualCenterX = afterBox.x + afterBox.width / 2;
    const residual = actualCenterX - targetCenterX;
    if (Math.abs(residual) > 0.25 && Math.abs(residual) < headBox.width) {
      setLyricX(el, targetCenterX - residual);
    }
  }
}

function positionLyricRowVertically(svg: SVGSVGElement, lyricNodes: SVGTextElement[]): void {
  if (lyricNodes.length === 0 || typeof lyricNodes[0]!.getBBox !== 'function') {
    return;
  }

  const labelBoxes = lyricNodes.map((el) => el.getBBox());
  const minLabelLeft = Math.min(...labelBoxes.map((b) => b.x));
  const currentMinTop = Math.min(...labelBoxes.map((b) => b.y));

  const staffEl = svg.querySelector<SVGGraphicsElement>('.abcjs-staff');
  const staffBottom =
    staffEl && typeof staffEl.getBBox === 'function'
      ? staffEl.getBBox().y + staffEl.getBBox().height
      : -Infinity;

  let lowestMusicBottom = staffBottom;
  for (const el of Array.from(
    svg.querySelectorAll<SVGGraphicsElement>('path, line, rect, polygon, circle, text'),
  )) {
    if (el.classList.contains('abcjs-lyric') || el.closest('.abcjs-lyric')) {
      continue;
    }
    if (typeof el.getBBox !== 'function') {
      continue;
    }
    const b = el.getBBox();
    if (b.width === 0 && b.height === 0) {
      continue;
    }
    // Ignore the treble clef descender on the far left when it sits well clear of all labels
    const isClef =
      el.classList.contains('abcjs-clef') ||
      el.closest('.abcjs-clef') !== null ||
      (el.getAttribute('data-name') ?? '').startsWith('clefs.');
    if (isClef && b.x + b.width < minLabelLeft - 4) {
      continue;
    }
    const bottom = b.y + b.height;
    if (bottom > lowestMusicBottom) {
      lowestMusicBottom = bottom;
    }
  }

  if (!Number.isFinite(lowestMusicBottom)) {
    return;
  }

  const targetTop = Math.max(
    staffBottom + MIN_LABEL_GAP_BELOW_STAFF,
    lowestMusicBottom + MIN_LABEL_GAP_BELOW_ELEMENT,
  );
  const deltaY = targetTop - currentMinTop;

  if (Math.abs(deltaY) < 0.05) {
    return;
  }

  for (const el of lyricNodes) {
    const rawY = Number.parseFloat(el.getAttribute('y') ?? '');
    if (Number.isFinite(rawY)) {
      el.setAttribute('y', (rawY + deltaY).toFixed(2));
    }
    for (const tspan of Array.from(el.querySelectorAll('tspan'))) {
      if (tspan.hasAttribute('y')) {
        const ty = Number.parseFloat(tspan.getAttribute('y') ?? '');
        if (Number.isFinite(ty)) {
          tspan.setAttribute('y', (ty + deltaY).toFixed(2));
        }
      }
    }
  }
}

function measureCenteredLabelCollisions(lyricNodes: SVGTextElement[]): SystemPostProcessResult {
  if (lyricNodes.length < 2 || typeof lyricNodes[0]!.getBBox !== 'function') {
    return { hasLabelCollision: false, worstRequiredScale: 1 };
  }

  const items = lyricNodes
    .map((el) => {
      const box = el.getBBox();
      return {
        left: box.x,
        right: box.x + box.width,
        cx: box.x + box.width / 2,
        width: box.width,
      };
    })
    .sort((a, b) => a.cx - b.cx);

  let hasLabelCollision = false;
  let worstRequiredScale = 1;
  for (let i = 1; i < items.length; i++) {
    const prev = items[i - 1]!;
    const curr = items[i]!;
    const gap = curr.left - prev.right;
    if (gap < MIN_LABEL_GAP_SVG_UNITS) {
      hasLabelCollision = true;
      const centerDist = Math.max(1, curr.cx - prev.cx);
      const neededCenterDist = (prev.width + curr.width) / 2 + MIN_LABEL_GAP_SVG_UNITS;
      const scale = neededCenterDist / centerDist;
      if (scale > worstRequiredScale) {
        worstRequiredScale = scale;
      }
    }
  }

  return { hasLabelCollision, worstRequiredScale };
}

function postProcessSystemSvg(wrapper: HTMLElement, svg: SVGSVGElement): SystemPostProcessResult {
  wrapper.classList.add('notation-system');
  wrapper.removeAttribute('style');

  // Remove <title> elements so PDF text extractors only see visible text
  for (const titleEl of Array.from(svg.querySelectorAll('title'))) {
    titleEl.remove();
  }

  // Remove empty/whitespace-only lyric placeholders created for '*' skips
  const lyricNodes: SVGTextElement[] = [];
  for (const el of Array.from(svg.querySelectorAll<SVGTextElement>('.abcjs-lyric'))) {
    const cleaned = (el.textContent ?? '').replace(/\u00a0/g, '').trim();
    if (cleaned.length === 0) {
      el.remove();
    } else {
      lyricNodes.push(el);
    }
  }

  for (const el of lyricNodes) {
    centerLyricOnNotehead(el);
  }

  positionLyricRowVertically(svg, lyricNodes);

  const collisionInfo = measureCenteredLabelCollisions(lyricNodes);

  const vbAttr = svg.getAttribute('viewBox');
  if (vbAttr) {
    const parts = vbAttr.trim().split(/\s+/).map(Number);
    if (parts.length === 4 && parts.every((n) => Number.isFinite(n))) {
      let [vx, vy, vw, vh] = parts as [number, number, number, number];
      const topGroup = svg.querySelector<SVGGElement>(':scope > g');
      if (topGroup && typeof topGroup.getBBox === 'function') {
        const bbox = topGroup.getBBox();
        if (bbox.width > 0 && bbox.height > 0) {
          const minY = bbox.y - VIEWBOX_TOP_PAD;
          const maxY = bbox.y + bbox.height + VIEWBOX_BOTTOM_PAD;
          const minX = Math.min(vx, bbox.x - 2);
          const maxX = Math.max(vx + vw, bbox.x + bbox.width + 2);
          vx = minX;
          vy = minY;
          vw = maxX - minX;
          vh = maxY - minY;
        }
      }
      svg.setAttribute('viewBox', `${vx.toFixed(2)} ${vy.toFixed(2)} ${vw.toFixed(2)} ${vh.toFixed(2)}`);
    }
  }

  svg.removeAttribute('width');
  svg.removeAttribute('height');
  svg.style.position = '';

  return collisionInfo;
}

function renderSystemsIntoHost(
  systemsHost: HTMLElement,
  abc: string,
  staffwidth: number,
): SystemPostProcessResult[] {
  systemsHost.replaceChildren();

  renderAbc(systemsHost, abc, {
    staffwidth,
    scale: 1.0,
    oneSvgPerLine: true,
    add_classes: true,
    paddingtop: 6,
    paddingbottom: 6,
    paddingleft: 4,
    paddingright: 4,
    selectTypes: false,
  });

  // abcjs sets an inline `overflow: hidden; height: ...px` on the container; clear it so
  // scaled SVGs and multi-page print pagination are never clipped.
  systemsHost.removeAttribute('style');

  const wrappers = Array.from(systemsHost.children).filter(
    (el): el is HTMLElement => el instanceof HTMLElement,
  );
  const results: SystemPostProcessResult[] = [];
  for (const wrapper of wrappers) {
    const svg = wrapper.querySelector('svg');
    if (svg instanceof SVGSVGElement) {
      results.push(postProcessSystemSvg(wrapper, svg));
    }
  }
  return results;
}

export function renderScore(
  container: HTMLElement,
  melody: Melody,
  opts?: NotationOptions,
): ScoreStats {
  const score = buildNotation(melody, opts);

  container.replaceChildren();

  const sheet = document.createElement('div');
  sheet.className = 'notation-sheet';

  if (score.title.length > 0) {
    const heading = document.createElement('h2');
    heading.className = 'notation-sheet-title';
    heading.textContent = score.title;
    sheet.appendChild(heading);
  }

  const systemsHost = document.createElement('div');
  systemsHost.className = 'notation-systems';
  sheet.appendChild(systemsHost);
  container.appendChild(sheet);

  const fingeringRepeat: FingeringRepeat = opts?.fingeringRepeat ?? 'every';
  let currentSystems = score.systems;
  let currentFingeringLabels = score.stats.fingeringLabels;
  let results = renderSystemsIntoHost(systemsHost, score.abc, TARGET_SYSTEM_WEIGHT);

  // If centred fingering labels still collide heavily in a multi-bar system (> 18% tighter than
  // TARGET_SYSTEM_WEIGHT), boost ONLY the measures in colliding multi-bar systems so unrelated
  // systems keep their even layout. Mild tight fits (<= 18%) are resolved cleanly via uniform
  // staffwidth expansion below so balanced system breaks stay intact.
  const measureBoosts = new Array<number>(score.measures.length).fill(1);
  for (let pass = 0; pass < 2; pass++) {
    let anyHeavyMultiBar = false;
    let barOffset = 0;
    for (let idx = 0; idx < currentSystems.length; idx++) {
      const sys = currentSystems[idx]!;
      const res = results[idx];
      if (
        res &&
        res.hasLabelCollision &&
        sys.measures.length > 1 &&
        res.worstRequiredScale > 1.18
      ) {
        anyHeavyMultiBar = true;
        const boostFactor = Math.min(1.45, res.worstRequiredScale * 1.05);
        for (let k = 0; k < sys.measures.length; k++) {
          measureBoosts[barOffset + k] = Math.max(
            measureBoosts[barOffset + k]!,
            measureBoosts[barOffset + k]! * boostFactor,
          );
        }
      }
      barOffset += sys.measures.length;
    }

    if (!anyHeavyMultiBar) {
      break;
    }

    const prevBreakKey = currentSystems.map((s) => s.measures.length).join(',');
    const next = layoutWithFingerings(
      score.measures,
      opts?.fingeringLabel,
      fingeringRepeat,
      measureBoosts,
    );
    const nextBreakKey = next.systems.map((s) => s.measures.length).join(',');
    if (nextBreakKey === prevBreakKey) {
      break;
    }
    currentSystems = next.systems;
    currentFingeringLabels = next.fingeringLabels;
    results = renderSystemsIntoHost(systemsHost, generateAbc(currentSystems), TARGET_SYSTEM_WEIGHT);
  }

  // Widen the staff until no labels collide; spacing does not scale exactly with width, so measure again.
  const maxWidth = TARGET_SYSTEM_WEIGHT * 2;
  let staffWidth = TARGET_SYSTEM_WEIGHT;
  while (staffWidth < maxWidth) {
    const worstScale = Math.max(1, ...results.map((r) => (r.hasLabelCollision ? r.worstRequiredScale : 1)));
    if (worstScale <= 1) break;
    staffWidth = Math.min(maxWidth, Math.ceil(staffWidth * worstScale * 1.08));
    results = renderSystemsIntoHost(systemsHost, generateAbc(currentSystems), staffWidth);
  }

  return {
    ...score.stats,
    fingeringLabels: currentFingeringLabels,
  };
}
