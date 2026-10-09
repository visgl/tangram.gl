// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

// @ts-check

/**
 * @typedef {Object} HtmlNode
 * @property {string} type AST node kind.
 * @property {string} [tagName] HTML element name.
 * @property {string} [value] Text content.
 * @property {{className?: string[] | string}} [properties] Element classes.
 * @property {HtmlNode[]} [children] Child nodes.
 */

/** @param {HtmlNode} node @returns {string[]} Element classes. */
function getClasses(node) {
  const classes = node.properties?.className;
  return Array.isArray(classes) ? classes : (classes || '').split(/\s+/);
}

/** @param {HtmlNode} node @param {boolean} preserveBreaks @returns {string} Plain code text. */
function getCodeText(node, preserveBreaks) {
  if (node.type === 'text') return node.value || '';
  if (node.tagName === 'br') return preserveBreaks ? '\n' : '';
  return (node.children || []).map(child => getCodeText(child, preserveBreaks)).join('');
}

/**
 * Preserve Docusaurus Prism code languages and exact line spacing before HTML-to-Markdown conversion.
 * @returns {(tree: HtmlNode) => void} Rehype transformer for the LLM-output plugin only.
 */
module.exports = function rehypeCodeBlocks() {
  /** @param {HtmlNode} node */
  function visit(node) {
    const code = node.tagName === 'pre' ? node.children?.find(child => child.tagName === 'code') : undefined;
    if (code) {
      const language = [...getClasses(code), ...getClasses(node)].find(name => name.startsWith('language-'));
      const lines = code.children?.filter(child => getClasses(child).includes('token-line')) || [];
      const text = lines.length ? lines.map(line => getCodeText(line, false)).join('\n') : getCodeText(code, true);
      code.properties = {...code.properties, className: language ? [language] : []};
      code.children = [{type: 'text', value: text}];
      node.children = [code];
      return;
    }
    for (const child of node.children || []) visit(child);
  }
  return visit;
};
