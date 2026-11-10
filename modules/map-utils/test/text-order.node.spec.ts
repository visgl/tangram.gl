// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test} from 'vitest';
import {prepareCanvasText} from '@tangram.gl/map-utils/text/canvas';
import {applyArabicShaping, orderVisualText} from '@tangram.gl/map-utils/text/explicit';

test('canvas preparation preserves logical text while explicit bidi produces visual lines', () => {
  const mixed = 'אב (Route 12)';
  const logical = prepareCanvasText(mixed);
  expect(logical).toMatchObject({order: 'logical', text: mixed});
  expect(orderVisualText(logical, [])).toEqual({order: 'visual', lines: ['(Route 12) בא']});
});

test('explicit line break offsets apply to shaped text, not the original label', () => {
  const shaped = applyArabicShaping('لا\nאב');
  expect(shaped).toBe('ﻻ\nאב');
  expect(orderVisualText({order: 'logical', text: shaped}, [2])).toEqual({
    order: 'visual',
    lines: ['ﻻ\n', 'בא']
  });
});

test('canvas keeps the legacy curved-label decision', () => {
  expect(prepareCanvasText('Main Street')).toMatchObject({rtl: false, noCurving: false});
  expect(prepareCanvasText('سلام')).toMatchObject({rtl: false, noCurving: true});
  expect(prepareCanvasText('سلام!')).toMatchObject({rtl: true, noCurving: false});
});
