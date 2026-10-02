// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/** Credits shared by the examples that use CARTO's public basemaps. */
export const CARTO_ATTRIBUTION = '<a href="https://carto.com/attributions">CARTO</a> © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>';

/** Return explicit scene credits while imports and TileJSON are still loading. */
export function getConfiguredAttributions(scene) {
  return [...new Set(Object.values(scene?.sources || {}).map(source => source?.attribution)
    .filter(value => typeof value === 'string' && value.trim()).map(value => value.trim()))];
}

/**
 * Render provider metadata as text and safe HTTP(S) links only.
 * Never attach arbitrary source HTML, handlers, images, styles or active URLs.
 */
export function createAttributionFragment(credits) {
  const fragment = document.createDocumentFragment();
  for (const [index, credit] of [...new Set(credits)].entries()) {
    if (index > 0) fragment.append(document.createTextNode(' | '));
    const template = document.createElement('template');
    template.innerHTML = credit;
    appendSafeCredit(template.content, fragment);
  }
  return fragment;
}

/** Replace a map's credits without requiring an attribution widget dependency. */
export function updateAttribution(element, credits) {
  element?.replaceChildren(createAttributionFragment(credits));
}

/** Recursively preserve text and safe links, stripping all other markup. */
function appendSafeCredit(source, target) {
  for (const node of source.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      target.append(document.createTextNode(node.textContent || ''));
    } else if (node instanceof Element && !['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'TEMPLATE'].includes(node.tagName)) {
      if (node.tagName === 'A') {
        const href = node.getAttribute('href') || '';
        try {
          const url = new URL(href);
          if (url.protocol === 'https:' || url.protocol === 'http:') {
            const link = document.createElement('a');
            link.href = url.href;
            link.rel = 'noopener noreferrer';
            link.textContent = node.textContent || '';
            target.append(link);
            continue;
          }
        } catch {
          // Invalid or relative provider URLs remain readable, non-clickable text.
        }
      }
      appendSafeCredit(node, target);
    }
  }
}
