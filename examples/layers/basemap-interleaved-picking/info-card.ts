// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/** What the info card shows for one picked feature. */
export type InfoCardContent = {
  /** The kind of feature: a basemap feature or a data feature. */
  eyebrow: string;
  title: string;
  /** Whether the feature is the selected one, which stays when the cursor leaves it. */
  isSelected: boolean;
  /** Where the feature comes from: its layer, its source and its id. */
  rows: [label: string, value: string][];
  /** The properties of the feature. */
  properties: [name: string, value: string][];
};

/** The look of the cards of this example. */
export const CARD_STYLE: Partial<CSSStyleDeclaration> = {
  position: 'absolute',
  boxSizing: 'border-box',
  padding: '12px 14px',
  borderRadius: '10px',
  font: '12px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif',
  color: '#1f2430',
  background: 'rgba(255, 255, 255, 0.95)',
  border: '1px solid rgba(15, 23, 42, 0.08)',
  boxShadow: '0 6px 24px rgba(15, 23, 42, 0.18)'
};

/** The color of secondary text on a card. */
export const MUTED_COLOR = '#667085';
/** The font of ids and property names. */
export const MONOSPACE_FONT = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
/** The card shows this many properties, and the count of the others. */
const MAX_PROPERTIES = 8;

/** Creates the card that names the feature under the cursor, for both kinds of feature. */
export function createInfoCard(document: Document): {
  element: HTMLDivElement;
  setContent: (content: InfoCardContent | null) => void;
} {
  const element = document.createElement('div');
  element.className = 'basemap-picking-info-card';
  Object.assign(element.style, CARD_STYLE, {
    top: '12px',
    right: '12px',
    width: '300px',
    maxWidth: 'calc(100% - 24px)',
    pointerEvents: 'none'
  });

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

  const createTable = (rows: [string, string][], monospace: boolean) => {
    const table = create('div', {
      display: 'grid',
      gridTemplateColumns: 'max-content minmax(0, 1fr)',
      columnGap: '12px',
      rowGap: '2px'
    });
    for (const [label, value] of rows) {
      table.append(
        create('span', {color: MUTED_COLOR, fontFamily: monospace ? MONOSPACE_FONT : ''}, label),
        create(
          'span',
          {fontFamily: MONOSPACE_FONT, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'},
          value
        )
      );
    }
    return table;
  };

  const setContent = (content: InfoCardContent | null) => {
    if (!content) {
      element.replaceChildren(
        create('div', {fontWeight: '600', fontSize: '13px'}, 'No feature'),
        create(
          'div',
          {color: MUTED_COLOR, marginTop: '4px'},
          'Point at a building, a road, a park or a census tract. Click to keep the feature.'
        )
      );
      return;
    }
    const {eyebrow, title, isSelected, rows, properties} = content;
    const shownProperties = properties.slice(0, MAX_PROPERTIES);
    const hiddenCount = properties.length - shownProperties.length;
    element.replaceChildren(
      create(
        'div',
        {
          color: MUTED_COLOR,
          fontSize: '11px',
          letterSpacing: '0.06em',
          textTransform: 'uppercase'
        },
        isSelected ? `${eyebrow} · selected` : eyebrow
      ),
      create(
        'div',
        {
          fontWeight: '600',
          fontSize: '15px',
          margin: '2px 0 8px',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap'
        },
        title
      ),
      createTable(rows, false),
      create('div', {
        height: '1px',
        margin: '9px 0 8px',
        background: 'rgba(15, 23, 42, 0.1)'
      }),
      properties.length > 0
        ? createTable(shownProperties, true)
        : create('div', {color: MUTED_COLOR}, 'No properties'),
      ...(hiddenCount > 0
        ? [create('div', {color: MUTED_COLOR, marginTop: '4px'}, `and ${hiddenCount} more`)]
        : [])
    );
  };
  setContent(null);
  return {element, setContent};
}
