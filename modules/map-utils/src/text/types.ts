// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/** Text in logical order; a native shaper may still apply bidi. */
export type LogicalLabelText = {
  /** Ordering understood by the consumer. */
  readonly order: 'logical';
  /** Logical input, in reading order. */
  readonly text: string;
};

/** Ordered glyph input; do not feed these lines through native bidi again. */
export type VisualLabelText = {
  /** Ordering understood by the consumer. */
  readonly order: 'visual';
  /** Lines in display order, with characters ordered for glyph placement. */
  readonly lines: readonly string[];
};
