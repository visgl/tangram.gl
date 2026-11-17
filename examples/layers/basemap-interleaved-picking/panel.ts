// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {CARD_STYLE, MONOSPACE_FONT, MUTED_COLOR} from './info-card';

/** A position of the data layer in the layer list of the basemap style. */
export type LayerPosition = {
  /** The id of the style layer that draws next above the data layer, or the value for the top. */
  value: string;
  label: string;
};

/** A choice in a list, such as a basemap style. */
export type Choice = {value: string; label: string};

/** The content of the control panel. */
export type ControlPanelProps = {
  title: string;
  summary: string;
  /** The label of the list of basemap styles. */
  styleLabel: string;
  styles: Choice[];
  /** The label of the list of positions. */
  positionLabel: string;
  legend: {
    title: string;
    source: string;
    /** The classes, from the lowest to the highest. */
    classes: {color: string; label: string}[];
  };
  onStyleChange: (value: string) => void;
  onPositionChange: (value: string) => void;
};

const ACCENT_COLOR = '#2563eb';
const BORDER_COLOR = 'rgba(15, 23, 42, 0.2)';
const ERROR_COLOR = '#b42318';

/**
 * Creates the panel that sets the position of the data layer among the style layers. It has a
 * list of all the positions, a button for each preset, and the legend of the data layer.
 */
export function createControlPanel(
  document: Document,
  props: ControlPanelProps
): {
  element: HTMLDivElement;
  /**
   * Sets the positions in the list, from the top of the map to the bottom, the positions that
   * have a button of their own, and the selected position.
   */
  setPositions: (positions: LayerPosition[], presets: LayerPosition[], value: string) => void;
  /** Selects a basemap style in the list, and does not call `onStyleChange`. */
  setStyle: (value: string) => void;
  /** Shows an error below the list of basemap styles, or removes it for null. */
  setError: (message: string | null) => void;
} {
  const create = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    style: Partial<CSSStyleDeclaration>,
    text?: string
  ) => {
    const node = document.createElement(tag);
    Object.assign(node.style, style);
    if (text !== undefined) {
      node.textContent = text;
    }
    return node;
  };

  const element = create('div', {
    ...CARD_STYLE,
    top: '12px',
    left: '12px',
    width: '320px',
    maxWidth: 'calc(100% - 24px)'
  });
  element.className = 'basemap-picking-control-panel';

  const createSelect = (label: string, fontFamily: string) => {
    const node = create('select', {
      width: '100%',
      boxSizing: 'border-box',
      padding: '6px 8px',
      borderRadius: '6px',
      border: `1px solid ${BORDER_COLOR}`,
      background: '#ffffff',
      color: 'inherit',
      fontSize: '12px',
      fontFamily,
      cursor: 'pointer'
    });
    node.setAttribute('aria-label', label);
    return node;
  };
  const createOptions = (choices: Choice[]) =>
    choices.map(choice => {
      const option = create('option', {}, choice.label);
      option.value = choice.value;
      return option;
    });

  const styleSelect = createSelect(props.styleLabel, 'inherit');
  styleSelect.dataset.control = 'style';
  styleSelect.append(...createOptions(props.styles));
  styleSelect.addEventListener('change', () => props.onStyleChange(styleSelect.value));
  const error = create('div', {display: 'none', marginTop: '6px', color: ERROR_COLOR});
  error.setAttribute('role', 'alert');

  const select = createSelect(props.positionLabel, MONOSPACE_FONT);
  select.dataset.control = 'position';
  select.addEventListener('change', () => setValue(select.value, true));

  let presetButtons: {button: HTMLButtonElement; value: string}[] = [];
  const presetRow = create('div', {display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '8px'});
  const setPresets = (presets: LayerPosition[]) => {
    presetButtons = presets.map(preset => {
      const button = create(
        'button',
        {
          padding: '4px 9px',
          borderRadius: '999px',
          border: `1px solid ${BORDER_COLOR}`,
          font: 'inherit',
          cursor: 'pointer'
        },
        preset.label
      );
      button.type = 'button';
      button.addEventListener('click', () => setValue(preset.value, true));
      return {button, value: preset.value};
    });
    presetRow.replaceChildren(...presetButtons.map(({button}) => button));
  };

  const legend = create('div', {
    marginTop: '12px',
    paddingTop: '10px',
    borderTop: '1px solid rgba(15, 23, 42, 0.1)'
  });
  const swatches = create('div', {display: 'flex', gap: '2px', margin: '6px 0 3px'});
  const labels = create('div', {display: 'flex', gap: '2px', color: MUTED_COLOR, fontSize: '11px'});
  for (const {color, label} of props.legend.classes) {
    swatches.append(create('span', {flex: '1', height: '10px', borderRadius: '2px', background: color}));
    labels.append(create('span', {flex: '1'}, label));
  }
  legend.append(
    create('div', {fontWeight: '600'}, props.legend.title),
    swatches,
    labels,
    create('div', {color: MUTED_COLOR, marginTop: '6px'}, props.legend.source)
  );

  element.append(
    create('div', {fontWeight: '650', fontSize: '15px'}, props.title),
    create('div', {color: MUTED_COLOR, margin: '4px 0 12px'}, props.summary),
    create('div', {fontWeight: '600', marginBottom: '5px'}, props.styleLabel),
    styleSelect,
    error,
    create('div', {fontWeight: '600', margin: '12px 0 5px'}, props.positionLabel),
    select,
    presetRow,
    legend
  );

  function setValue(value: string, notify: boolean) {
    select.value = value;
    for (const preset of presetButtons) {
      const isActive = preset.value === value;
      preset.button.style.background = isActive ? ACCENT_COLOR : '#ffffff';
      preset.button.style.color = isActive ? '#ffffff' : 'inherit';
      preset.button.style.borderColor = isActive ? ACCENT_COLOR : BORDER_COLOR;
      preset.button.setAttribute('aria-pressed', String(isActive));
    }
    if (notify) {
      props.onPositionChange(value);
    }
  }

  return {
    element,
    setPositions: (positions, presets, value) => {
      select.replaceChildren(...createOptions(positions));
      setPresets(presets);
      setValue(value, false);
    },
    setStyle: value => {
      styleSelect.value = value;
    },
    setError: message => {
      error.textContent = message ?? '';
      error.style.display = message ? 'block' : 'none';
    }
  };
}
