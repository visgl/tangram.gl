// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {processBidirectionalText} from './bidi';
import type {LogicalLabelText, VisualLabelText} from './types';

export {applyArabicShaping} from './arabic-shaping';
export {containsRightToLeftText, processBidirectionalText} from './bidi';

/**
 * Reorder a logical label for glyph placement. Breaks are UTF-16 offsets into
 * the supplied text, after any Arabic shaping, not into the original string.
 */
export function orderVisualText(
  label: LogicalLabelText,
  lineBreaks: number[]
): VisualLabelText {
  return {order: 'visual', lines: processBidirectionalText(label.text, lineBreaks)};
}
