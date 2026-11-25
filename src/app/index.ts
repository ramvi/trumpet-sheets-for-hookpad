import './styles.css';
import { fingeringLabel } from '../fingering';
import type { NoteNaming } from '../model/pitch';
import { renderScore } from '../notation';
import type { ScoreStats } from '../notation';
import type { InputPitch, RegisterProfile } from '../transpose';
import exampleClip from './example.json?raw';
import { PICKER_MIDIS, PROFILE_FIELDS, formatMidiPitch } from './profile';
import { loadPersistedState, savePersistedState } from './storage';
import {
  DEFAULT_TITLE,
  METER_DENOMINATORS,
  METER_NUMERATORS,
  computeView,
  createInitialState,
  formatError,
  withRawInput,
} from './viewModel';
import type { AppState, AppViewModel, FingeringMode, Theme } from './viewModel';

const TYPING_DEBOUNCE_MS = 150;

const RESET_CHOICE = { selectedCandidateSemitones: null, allowOutOfRange: false } as const;

type Result = NonNullable<AppViewModel['result']>;
type Attrs = Record<string, string | boolean>;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value !== false) {
      node.setAttribute(name, value === true ? '' : value);
    }
  }
  node.append(...children);
  return node;
}

function options(values: readonly number[], label: (value: number) => string = String): HTMLOptionElement[] {
  return values.map((value) => el('option', { value: String(value) }, label(value)));
}

function button(className: string, text: string, onClick: () => void): HTMLButtonElement {
  const node = el('button', { type: 'button', class: `btn ${className}` }, text);
  node.addEventListener('click', onClick);
  return node;
}

/** Shows `text` in `node`, or hides the node when `text` is empty. */
function setNote(node: HTMLElement, text: string | null): void {
  node.textContent = text;
  node.hidden = !text;
}

function segmented<T extends string>(
  legend: string,
  name: string,
  choices: readonly (readonly [value: T, label: string])[],
  onChange: (value: T) => void,
): { node: HTMLFieldSetElement; setValue: (value: T) => void } {
  const inputs = choices.map(([value]) => {
    const input = el('input', { type: 'radio', name, value });
    input.addEventListener('change', () => onChange(value));
    return input;
  });
  const labels = choices.map(([, text], i) => el('label', {}, inputs[i]!, el('span', {}, text)));
  return {
    node: el('fieldset', { class: 'field' }, el('legend', {}, legend), el('div', { class: 'segments' }, ...labels)),
    setValue: (value) => {
      for (const input of inputs) {
        input.checked = input.value === value;
      }
    },
  };
}

/** Position of a pitch on a range bar, which spans the player's limits plus a small margin. */
function rangePercent(midi: number, { limitLow, limitHigh }: RegisterProfile): string {
  const ratio = (midi - limitLow + 2) / (limitHigh - limitLow + 4);
  return `${Math.min(1, Math.max(0, ratio)) * 100}%`;
}

/** Mounts the application UI into `root`. */
export function startApp(root: HTMLElement): void {
  let state: AppState = { ...createInitialState(), ...loadPersistedState() };

  function update(patch: Partial<AppState>): void {
    state = { ...state, ...patch };
    savePersistedState(state);
    render();
  }

  // Clip
  const clipInput = el('textarea', {
    id: 'hookpad-input',
    class: 'input clip-input',
    placeholder: 'Paste one or more Hookpad clips here',
    spellcheck: 'false',
    'aria-label': 'Hookpad clip',
  });
  clipInput.value = state.rawInput;
  const clipSummary = el('summary', {});
  const clipDetails = el('details', { class: 'clip-details' }, clipSummary, clipInput);
  const importError = el('p', { class: 'alert alert-error', role: 'alert' });
  const warnings = el('ul', { class: 'alert alert-warning', role: 'status' });
  const exampleButton = button('btn-secondary', 'Try an example', () => setInput(exampleClip));
  const clearButton = button('btn-quiet clear', 'Clear', () => {
    setInput('');
    clipInput.focus();
  });
  const pitchControl = segmented<InputPitch>(
    'Pitch in the clip',
    'input-pitch',
    [
      ['concert', 'Concert pitch'],
      ['written', 'Written for B♭'],
    ],
    (inputPitch) => update({ inputPitch, ...RESET_CHOICE }),
  );
  const voiceSelect = el('select', { id: 'voice-select', class: 'input' });
  const voiceField = el('div', { class: 'field' }, el('label', { for: 'voice-select' }, 'Voice'), voiceSelect);
  const numerator = el('select', { class: 'input', 'aria-label': 'Beats per bar' }, ...options(METER_NUMERATORS));
  const denominator = el('select', { class: 'input', 'aria-label': 'Beat unit' }, ...options(METER_DENOMINATORS));
  const meterField = el(
    'div',
    { class: 'label-row' },
    el(
      'div',
      {},
      el('div', { class: 'label' }, 'Time signature'),
      el('div', { class: 'hint' }, 'Not part of the clip'),
    ),
    el('div', { class: 'meter' }, numerator, '/', denominator),
  );
  const clipSection = el(
    'section',
    { class: 'group clip' },
    el('p', { class: 'intro' }, 'Copy a melody in Hookpad and paste it here to get a sheet for B♭ trumpet.'),
    clipDetails,
    clearButton,
    importError,
    warnings,
    el('div', { class: 'actions unloaded-only' }, exampleButton, el('span', { class: 'hint' }, 'Everything stays in your browser.')),
    el('div', { class: 'group loaded-only' }, pitchControl.node, voiceField, meterField),
  );

  // Result
  const hookpadKey = el('strong', { class: 'hookpad-key' });
  const hookpadInstruction = el('p', { class: 'hint' });
  const hookpadCard = el(
    'section',
    { class: 'hookpad-card', 'aria-live': 'polite' },
    el('span', { class: 'label' }, 'Set Hookpad to'),
    hookpadKey,
    hookpadInstruction,
  );
  const choiceList = el('div', { class: 'choices', role: 'group', 'aria-label': 'Trumpet key' });
  const outOfRangeNote = el('p', { class: 'alert alert-warning' });
  const choiceSection = el(
    'section',
    { class: 'field' },
    el(
      'div',
      { class: 'label-row' },
      el('span', { class: 'label' }, 'Trumpet key'),
      el('span', { class: 'hint' }, 'Shaded: your comfort range'),
    ),
    choiceList,
    outOfRangeNote,
  );

  // Sheet
  const titleInput = el('input', { type: 'text', id: 'sheet-title', class: 'input', placeholder: DEFAULT_TITLE });
  titleInput.value = state.title;
  const fingeringControl = segmented<FingeringMode>(
    'Fingerings',
    'fingerings',
    [
      ['every', 'All'],
      ['first-in-run', 'First of repeats'],
      ['off', 'None'],
    ],
    (fingerings) => update({ fingerings }),
  );
  const sheetSection = el(
    'section',
    { class: 'group' },
    el('div', { class: 'field' }, el('label', { for: 'sheet-title' }, 'Sheet title'), titleInput),
    fingeringControl.node,
  );

  // Settings
  const namingControl = segmented<NoteNaming>(
    'Name for B natural',
    'note-naming',
    [
      ['B', 'B'],
      ['H', 'H'],
    ],
    (noteNaming) => update({ noteNaming }),
  );
  const themeControl = segmented<Theme>(
    'Appearance (prints are always light)',
    'theme',
    [
      ['system', 'System'],
      ['light', 'Light'],
      ['dark', 'Dark'],
    ],
    (theme) => update({ theme }),
  );
  const pickers = new Map(
    PROFILE_FIELDS.map(({ key, label }) => {
      const picker = el('select', { class: 'input', 'aria-label': label }, ...options(PICKER_MIDIS));
      picker.addEventListener('change', () =>
        update({ profile: { ...state.profile, [key]: Number(picker.value) }, ...RESET_CHOICE }),
      );
      return [key, picker];
    }),
  );
  const rangeRow = (title: string, ...keys: (keyof RegisterProfile)[]) => [
    el('span', { class: 'label' }, title),
    el('div', { class: 'range-pickers' }, ...keys.map((key) => pickers.get(key)!)),
  ];
  const profileError = el('p', { class: 'alert alert-error', role: 'alert' });
  const settings = el(
    'dialog',
    { class: 'settings no-print', 'aria-labelledby': 'settings-title' },
    el('h2', { id: 'settings-title' }, 'Settings'),
    themeControl.node,
    namingControl.node,
    el(
      'section',
      { class: 'field' },
      el('span', { class: 'label' }, 'Your range, in written pitch'),
      el('p', { class: 'hint' }, 'Keys are chosen to stay inside the limits and close to the preferred range.'),
      el(
        'div',
        { class: 'range-grid' },
        ...rangeRow('Limits', 'limitLow', 'limitHigh'),
        ...rangeRow('Comfort', 'comfortLow', 'comfortHigh'),
        ...rangeRow('Preferred', 'preferredLow', 'preferredHigh'),
        ...rangeRow('Center', 'center'),
      ),
      profileError,
    ),
    el(
      'div',
      { class: 'dialog-actions' },
      button('btn-quiet', 'Reset range', () => update({ profile: createInitialState().profile, ...RESET_CHOICE })),
      button('btn-primary', 'Done', () => settings.close()),
    ),
  );
  const openSettings = () => settings.showModal();

  // Stage
  const messageTitle = el('h2', {});
  const messageText = el('p', {});
  const messageList = el('ul', {});
  const useAnyway = button('btn-primary', 'Use it anyway', () => update({ allowOutOfRange: true }));
  const adjustRange = button('btn-secondary', 'Adjust your range', openSettings);
  const message = el(
    'section',
    { class: 'message no-print', role: 'alert' },
    messageTitle,
    messageText,
    messageList,
    el('div', { class: 'actions' }, useAnyway, adjustRange),
  );
  const sheetHost = el('div', { id: 'sheet-host' });
  const printButton = button('btn-primary', 'Print / save as PDF', () => window.print());

  const shell = el(
    'div',
    { class: 'shell' },
    el(
      'header',
      { class: 'topbar no-print' },
      el('h1', {}, 'Trumpet Sheets ', el('span', {}, 'for Hookpad')),
      button('btn-quiet', 'Settings', openSettings),
      printButton,
    ),
    el('aside', { class: 'panel no-print' }, clipSection, hookpadCard, choiceSection, sheetSection),
    el('main', { class: 'stage' }, message, sheetHost),
    settings,
  );
  root.replaceChildren(shell);

  let renderedScoreKey: string | null = null;
  let wasLoaded: boolean | null = null;

  function renderChoices(result: Result): void {
    const { profile } = state;
    choiceList.style.setProperty('--comfort-low', rangePercent(profile.comfortLow, profile));
    choiceList.style.setProperty('--comfort-high', rangePercent(profile.comfortHigh, profile));
    const hadFocus = choiceList.contains(document.activeElement);
    choiceList.replaceChildren(
      ...result.choices.map((choice) => {
        const bar = el('span', { class: 'range-bar', 'aria-hidden': 'true' }, el('span', {}));
        bar.style.setProperty('--low', rangePercent(choice.lowMidi, profile));
        bar.style.setProperty('--high', rangePercent(choice.highMidi, profile));
        const node = button('choice', '', () =>
          update({
            selectedCandidateSemitones: choice.isRecommended ? null : choice.semitones,
            allowOutOfRange: state.allowOutOfRange || !result.anyFits,
          }),
        );
        node.setAttribute('aria-pressed', String(choice.isSelected));
        node.classList.toggle('is-outside', !choice.fits);
        node.append(
          el('span', { class: 'choice-key' }, choice.writtenKeyLabel),
          choice.isRecommended ? el('span', { class: 'tag' }, 'Best') : '',
          el('span', { class: 'choice-range' }, choice.rangeLabel),
          choice.fits ? '' : el('span', { class: 'visually-hidden' }, 'outside your limits'),
          bar,
        );
        return node;
      }),
    );
    if (hadFocus) {
      choiceList.querySelector<HTMLElement>('[aria-pressed="true"]')?.focus();
    }
  }

  /** Draws the score if it changed. Returns an error message when drawing fails. */
  function renderSheet(result: Result | null): string | null {
    const scoreKey =
      result &&
      JSON.stringify([
        state.rawInput,
        state.inputPitch,
        state.fingerings,
        state.selectedVoiceId,
        state.meter,
        state.title,
        state.profile,
        result.candidate.semitones,
      ]);
    if (scoreKey === renderedScoreKey) {
      return null;
    }
    sheetHost.replaceChildren();
    renderedScoreKey = null;
    if (!result) {
      return null;
    }
    try {
      const stats: ScoreStats = renderScore(sheetHost, result.candidate.melody, {
        title: state.title,
        ...(state.fingerings === 'off' ? {} : { fingeringLabel, fingeringRepeat: state.fingerings }),
      });
      sheetHost.dataset.onsets = String(stats.onsets);
      renderedScoreKey = scoreKey;
      return null;
    } catch (err: unknown) {
      sheetHost.replaceChildren();
      return formatError('Could not draw the sheet', err);
    }
  }

  function renderMessage(vm: AppViewModel, error: string | null): void {
    const { result } = vm;
    const noFit = !error && vm.showNoFitBlocker && result;
    if (error) {
      messageTitle.textContent = 'Something went wrong';
      messageText.textContent = error;
    } else if (noFit) {
      messageTitle.textContent = 'This melody does not fit your range';
      messageText.textContent = `No key fits within ${noFit.limitsLabel}. The closest is ${noFit.writtenKeyLabel} (${noFit.rangeLabel}), with these notes outside:`;
    } else if (vm.status === 'profile-error') {
      messageTitle.textContent = 'Your range needs fixing';
      messageText.textContent = vm.profileError;
    }
    message.hidden = !error && !noFit && vm.status !== 'profile-error';
    messageList.replaceChildren(
      ...(noFit ? noFit.outOfRangeSummary.map((item) => el('li', {}, item.description)) : []),
    );
    useAnyway.hidden = !noFit;
    adjustRange.hidden = !noFit && vm.status !== 'profile-error';
  }

  function render(): void {
    const { noteNaming } = state;
    const vm = computeView(state);
    const { result } = vm;

    const loaded = vm.status !== 'empty' && vm.status !== 'import-error';
    shell.classList.toggle('is-unloaded', !loaded);
    pitchControl.setValue(state.inputPitch);
    fingeringControl.setValue(state.fingerings);
    namingControl.setValue(noteNaming);
    themeControl.setValue(state.theme);
    document.documentElement.dataset.theme = state.theme;
    for (const [key, picker] of pickers) {
      PICKER_MIDIS.forEach((midi, i) => {
        picker.options[i]!.textContent = formatMidiPitch(midi, noteNaming);
      });
      picker.value = String(state.profile[key]);
    }

    clipSummary.textContent = vm.clipSummary ?? 'Hookpad clip';
    if (loaded !== wasLoaded) {
      const hadFocus = clipSection.contains(document.activeElement);
      clipDetails.open = !loaded;
      if (loaded && hadFocus) {
        clipSummary.focus();
      }
      wasLoaded = loaded;
    }
    clearButton.hidden = vm.status === 'empty';
    setNote(importError, vm.importError);
    setNote(profileError, vm.profileError);
    warnings.replaceChildren(...vm.warnings.map((w) => el('li', {}, w)));
    warnings.hidden = vm.warnings.length === 0;

    voiceField.hidden = vm.voices.length <= 1;
    voiceSelect.replaceChildren(...vm.voices.map((v) => el('option', { value: v.id }, v.displayLabel)));
    voiceSelect.value = vm.selectedVoiceId ?? '';

    numerator.value = String(state.meter.numerator);
    denominator.value = String(state.meter.denominator);

    hookpadCard.hidden = choiceSection.hidden = sheetSection.hidden = !result;
    if (result) {
      hookpadKey.textContent = result.hookpadKeyLabel;
      hookpadInstruction.textContent = result.hookpadInstruction;
      setNote(
        outOfRangeNote,
        result.candidate.fits || vm.showNoFitBlocker ? null : 'This key has notes outside your limits.',
      );
      renderChoices(result);
    }

    const drawError = renderSheet(vm.shouldRenderScore ? result : null);
    renderMessage(vm, vm.runtimeError ?? drawError);
    printButton.disabled = !vm.canPrint || drawError !== null;
  }

  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  function setInput(value: string): void {
    clearTimeout(debounceTimer);
    clipInput.value = value;
    update(withRawInput(state, value));
  }

  clipInput.addEventListener('input', (event) => {
    clearTimeout(debounceTimer);
    const typed = event instanceof InputEvent && event.inputType === 'insertText';
    debounceTimer = setTimeout(() => setInput(clipInput.value), typed ? TYPING_DEBOUNCE_MS : 0);
  });
  document.addEventListener('paste', (event) => {
    const text = event.clipboardData?.getData('text/plain').trim() ?? '';
    if (/^[[{]/.test(text) && !settings.open && !document.activeElement?.closest('input[type="text"], textarea')) {
      setInput(clipInput.value ? `${clipInput.value}\n\n${text}` : text);
    }
  });
  voiceSelect.addEventListener('change', () =>
    update({ selectedVoiceId: voiceSelect.value, ...RESET_CHOICE }),
  );
  const onMeterChange = () =>
    update({ meter: { numerator: Number(numerator.value), denominator: Number(denominator.value) } });
  numerator.addEventListener('change', onMeterChange);
  denominator.addEventListener('change', onMeterChange);
  titleInput.addEventListener('input', () => update({ title: titleInput.value }));

  render();
}
