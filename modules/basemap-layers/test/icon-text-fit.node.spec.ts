// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {afterEach, describe, expect, test, vi} from 'vitest';
import {log} from '@deck.gl/core';
import {IconLayer} from '@deck.gl/layers';
import {PLACEMENT_VIEWPORT_PADDING} from '../src/label-placement.ts';
import type {PlacementSymbol} from '../src/label-placement.ts';
import {MVTLabelLayer} from '../src/mvt-label-layer.ts';
import {getIconPartName, getSpriteIconMapping, getStretchIconMapping} from '../src/sprite.ts';
import type {SpriteAtlas} from '../src/sprite.ts';
import {
  STRETCH_ICON_SHADER_PATCHES,
  StretchIconLayer,
  patchIconShader
} from '../src/stretch-icon-layer.ts';
import {
  applyTextFit,
  fitIconToText,
  getFittedIconCollisionBox,
  getIconQuadBox,
  getIconQuads,
  isValidStretchMetadata
} from '../src/icon-text-fit.ts';
import type {IconQuad, StretchableImage, SymbolBox} from '../src/icon-text-fit.ts';

/** A 60 by 20 pixel label centered on its anchor. */
const TEXT: SymbolBox = {left: -30, top: -10, right: 30, bottom: 10};
/** `icon-text-fit-padding`: top, right, bottom, left. */
const PADDING = [2, 3, 4, 5];

/** A 20 pixel shield whose 4 pixel border is fixed and whose middle stretches. */
const SHIELD: StretchableImage = {
  width: 20,
  height: 20,
  pixelRatio: 1,
  stretchX: [[4, 16]],
  stretchY: [[4, 16]]
};

const asArray = (box: SymbolBox) => [box.left, box.top, box.right, box.bottom];
const getBoxes = (quads: IconQuad[], iconSize: number) =>
  quads.map(quad => asArray(getIconQuadBox(quad, iconSize)));
const getParts = (quads: IconQuad[]) =>
  quads.map(({image}) => [image.x, image.y, image.width, image.height]);

describe('fitIconToText', () => {
  test.each([
    ['both', [-35, -12, 33, 14]],
    // Not stretched vertically: the icon keeps its 20 pixels, centered on the label.
    ['width', [-35, -10, 33, 10]],
    ['height', [-10, -12, 10, 14]]
  ] as const)('%s stretches the icon to the padded label', (fit, expected) => {
    expect(asArray(fitIconToText(SHIELD, TEXT, fit, PADDING, [0, 0]))).toEqual(expected);
  });

  test('icon-offset moves the fitted box; the image size is in CSS pixels', () => {
    const image = {...SHIELD, width: 40, height: 40, pixelRatio: 2};
    const fitted = fitIconToText(image, {...TEXT, left: 0, right: 60}, 'width', PADDING, [7, -3]);
    // 40 image pixels at pixel ratio 2 are 20 CSS pixels.
    expect(asArray(fitted)).toEqual([7 - 5, -13, 7 + 63, 7]);
    expect(fitted.collisionPadding).toBeUndefined();
  });

  test('content gives the CSS pixels of the image outside it', () => {
    const image: StretchableImage = {width: 30, height: 20, pixelRatio: 2, content: [6, 4, 24, 16]};
    const fitted = fitIconToText(image, TEXT, 'both', [0, 0, 0, 0], [0, 0]);
    expect(fitted.collisionPadding).toEqual([3, 2, 3, 2]);
  });
});

describe('getIconQuads', () => {
  test('an image without stretch zones is one quad, all of it stretched over the box', () => {
    const image: StretchableImage = {width: 16, height: 12, pixelRatio: 1};
    const quads = getIconQuads(image, fitIconToText(image, TEXT, 'both', PADDING, [0, 0]));
    expect(getParts(quads)).toEqual([[0, 0, 16, 12]]);
    expect(getBoxes(quads, 1)).toEqual([[-35, -12, 33, 14]]);
    // `icon-size` scales the whole box about the anchor.
    expect(getBoxes(quads, 2)).toEqual([[-70, -24, 66, 28]]);
  });

  test('stretch zones cut the image in nine; the fixed zones keep their size', () => {
    const quads = getIconQuads(SHIELD, fitIconToText(SHIELD, TEXT, 'both', PADDING, [0, 0]));
    expect(getParts(quads)).toEqual([
      [0, 0, 4, 4],
      [0, 4, 4, 12],
      [0, 16, 4, 4],
      [4, 0, 12, 4],
      [4, 4, 12, 12],
      [4, 16, 12, 4],
      [16, 0, 4, 4],
      [16, 4, 4, 12],
      [16, 16, 4, 4]
    ]);
    expect(getBoxes(quads, 1)).toEqual([
      [-35, -12, -31, -8],
      [-35, -8, -31, 10],
      [-35, 10, -31, 14],
      [-31, -12, 29, -8],
      [-31, -8, 29, 10],
      [-31, 10, 29, 14],
      [29, -12, 33, -8],
      [29, -8, 33, 10],
      [29, 10, 33, 14]
    ]);
    // At `icon-size` 2 the box doubles, and the 4 pixel corners stay 4 pixels.
    const corners = getBoxes(quads, 2);
    expect(corners[0]).toEqual([-70, -24, -66, -20]);
    expect(corners[8]).toEqual([62, 24, 66, 28]);
  });

  test('a fitted box smaller than the fixed zones collapses the stretched zone, not below zero', () => {
    const quads = getIconQuads(SHIELD, fitIconToText(SHIELD, TEXT, 'both', PADDING, [0, 0]));
    // The 8 fixed pixels of 68: the least scale on x.
    expect(quads[0].minScale[0]).toBeCloseTo(8 / 68, 12);
    const [left, middle, right] = getBoxes(quads, 0.05).filter((_, i) => i % 3 === 1);
    expect(left[2] - left[0]).toBeCloseTo(4, 12);
    expect(middle[2] - middle[0]).toBeCloseTo(0, 12);
    expect(right[2] - right[0]).toBeCloseTo(4, 12);
  });

  test('several stretch zones share what the box adds by their sizes', () => {
    const image: StretchableImage = {
      width: 20,
      height: 10,
      pixelRatio: 1,
      // 2 and 6 pixels stretch; 12 are fixed.
      stretchX: [
        [2, 4],
        [10, 16]
      ]
    };
    const quads = getIconQuads(image, fitIconToText(image, TEXT, 'width', [0, 0, 0, 0], [0, 0]));
    // Rows of no height (above and below the default vertical zone) are left out.
    expect(getParts(quads)).toEqual([
      [0, 0, 2, 10],
      [2, 0, 2, 10],
      [4, 0, 6, 10],
      [10, 0, 6, 10],
      [16, 0, 4, 10]
    ]);
    // 60 pixels: 12 fixed, 48 shared by the 2 and 6 pixel zones as 12 and 36.
    expect(getBoxes(quads, 1).map(([x1, , x2]) => x2 - x1)).toEqual([2, 12, 6, 36, 4]);
    expect(getBoxes(quads, 1)[0][0]).toBe(-30);
  });

  test('content is what covers the box; the image outside it extends beyond', () => {
    const image: StretchableImage = {width: 30, height: 20, pixelRatio: 2, content: [6, 4, 24, 16]};
    const quads = getIconQuads(image, fitIconToText(image, TEXT, 'both', [0, 0, 0, 0], [0, 0]));
    expect(getParts(quads)).toEqual([[0, 0, 30, 20]]);
    // 18 content pixels across 60 CSS pixels: the 6 pixels outside each side are 20 CSS pixels.
    const [[left, top, right, bottom]] = getBoxes(quads, 1);
    expect(left).toBeCloseTo(-50, 12);
    expect(right).toBeCloseTo(50, 12);
    // 12 content pixels across 20: the 4 pixels above and below are 20 / 3.
    expect(top).toBeCloseTo(-10 - 20 / 3, 12);
    expect(bottom).toBeCloseTo(10 + 20 / 3, 12);
  });

  test('content with stretch zones: the fixed zones outside the content keep their size', () => {
    const image: StretchableImage = {
      width: 20,
      height: 20,
      pixelRatio: 1,
      stretchX: [[4, 16]],
      stretchY: [[4, 16]],
      content: [2, 2, 18, 18]
    };
    const quads = getIconQuads(image, fitIconToText(image, TEXT, 'both', [0, 0, 0, 0], [0, 0]));
    const boxes = getBoxes(quads, 1);
    // The content's 2 fixed pixels inside each border lie inside the box; the 2 outside it beyond.
    expect(boxes[0]).toEqual([-32, -12, -28, -8]);
    expect(boxes[8]).toEqual([28, 8, 32, 12]);
  });
});

describe('applyTextFit', () => {
  const image: StretchableImage = {width: 20, height: 10, pixelRatio: 1, content: [0, 0, 20, 10]};
  const fitted = fitIconToText(image, TEXT, 'both', [0, 0, 0, 0], [0, 0]);

  test('proportional height keeps the content aspect ratio from the height', () => {
    const fit = {...image, textFitWidth: 'proportional', textFitHeight: 'proportional'} as const;
    expect(asArray(applyTextFit(fit, fitted))).toEqual([-20, -10, 20, 10]);
    const quads = getIconQuads(fit, fitted);
    expect(getBoxes(quads, 1)).toEqual([[-20, -10, 20, 10]]);
  });

  test('proportional width with stretchOnly height grows the height', () => {
    const fit = {...image, textFitWidth: 'proportional', textFitHeight: 'stretchOnly'} as const;
    expect(asArray(applyTextFit(fit, fitted))).toEqual([-30, -15, 30, 15]);
  });

  test('stretchOrShrink on both axes matches the content to the box', () => {
    const fit = {...image, textFitWidth: 'stretchOrShrink'} as const;
    expect(asArray(applyTextFit(fit, fitted))).toEqual([-30, -10, 30, 10]);
  });
});

describe('getFittedIconCollisionBox', () => {
  test('the fitted box at icon-size, padded, and widened by the image outside content', () => {
    const image: StretchableImage = {width: 30, height: 20, pixelRatio: 2, content: [6, 4, 24, 16]};
    const fitted = fitIconToText(image, TEXT, 'both', [0, 0, 0, 0], [0, 0]);
    expect(getFittedIconCollisionBox(image, fitted, 1, [1, 1, 1, 1])).toEqual([-34, -13, 34, 13]);
    expect(getFittedIconCollisionBox(image, fitted, 2, [1, 2, 3, 4])).toEqual([
      -60 - 4 - 6,
      -20 - 1 - 4,
      60 + 2 + 6,
      20 + 3 + 4
    ]);
  });

  test('without content, the fitted box', () => {
    const fitted = fitIconToText(SHIELD, TEXT, 'both', PADDING, [0, 0]);
    expect(getFittedIconCollisionBox(SHIELD, fitted, 1, [0, 0, 0, 0])).toEqual([-35, -12, 33, 14]);
  });
});

describe('isValidStretchMetadata', () => {
  test.each([
    [{}, true],
    [{stretchX: [[4, 16]], stretchY: [[0, 20]], content: [0, 0, 20, 20]}, true],
    [{stretchX: [[2, 4], [8, 12]]}, true],
    [{stretchX: [[8, 12], [2, 4]]}, false],
    [{stretchX: [[4, 2]]}, false],
    [{stretchY: [[4, 21]]}, false],
    [{stretchX: [4, 16]}, false],
    [{content: [4, 4, 2, 16]}, false],
    [{content: [4, 4, 16, 21]}, false],
    [{content: [-1, 4, 16, 16]}, false],
    [{content: [4, 4, 16]}, false]
  ])('%j: %s', (metadata, valid) => {
    expect(isValidStretchMetadata({width: 20, height: 20, pixelRatio: 1, ...(metadata as any)})).toBe(
      valid
    );
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const ATLAS: SpriteAtlas = {
  id: 'default',
  image: 'https://example.com/sprite.png',
  mapping: getSpriteIconMapping({
    // A 12 pixel shield whose 4 pixel border is fixed.
    shield: {x: 24, y: 0, width: 12, height: 12, stretchX: [[4, 8]], stretchY: [[4, 8]]},
    plain: {x: 0, y: 0, width: 8, height: 4}
  } as any)
};

/** A label layer over one point per `rows` entry at zoom 8, its sprite loaded. */
function labelLayer(layout: Record<string, unknown>, rows: Record<string, unknown>[]): any {
  const layer: any = new MVTLabelLayer({
    id: 'labels',
    config: {labels: true},
    styleLayer: {layout, paint: {}},
    zoom: 8,
    spriteAtlases: [ATLAS]
  } as any);
  layer.state = {
    labelData: rows.map((properties, index) => ({
      position: [100, 0],
      __source: {object: {geometry: {type: 'Point', coordinates: [100, 0]}, properties}, index}
    }))
  };
  layer.context = {viewport: {}} as any;
  layer.internalState = {subLayers: []} as any;
  layer.project = () => [100, 100];
  return layer;
}

// Without a canvas every character is half an em: 'abcd' at text-size 10 is 20 by 12 pixels.
const FIT_LAYOUT = {
  'text-field': ['get', 'name'],
  'text-size': 10,
  'icon-text-fit': 'both',
  'icon-text-fit-padding': [1, 2, 3, 4]
};

describe('MVTLabelLayer icon-text-fit', () => {
  const viewport = {width: 400, height: 200, bearing: 0};
  const getIconBox = (layer: any) => {
    const out: PlacementSymbol[] = [];
    layer.getPlacementSymbols(viewport, 0, out);
    return out[0].icon!.box!.map(v => v - PLACEMENT_VIEWPORT_PADDING - 100);
  };
  const info = (index: number) => ({index, data: [], target: []});

  test('the icon collides by its box fitted to the text, padded by icon-padding', () => {
    const layout = {...FIT_LAYOUT, 'icon-image': 'shield', 'icon-padding': 0};
    expect(getIconBox(labelLayer(layout, [{name: 'abcd'}]))).toEqual([-14, -7, 12, 9]);
    // `icon-size` scales the fitted box.
    expect(getIconBox(labelLayer({...layout, 'icon-size': 2}, [{name: 'abcd'}]))).toEqual([
      -28, -14, 24, 18
    ]);
    // Without icon-text-fit, the image at its own size.
    expect(
      getIconBox(labelLayer({...layout, 'icon-text-fit': 'none'}, [{name: 'abcd'}]))
    ).toEqual([-6, -6, 6, 6]);
  });

  /**
   * The icons that `layers` draw, in draw order: each layer in turn draws its data in order. Each
   * entry is the index of the drawn row in `getRows` and the icon's name.
   */
  const getDrawOrder = (layer: any, layers: any[]) => {
    const rows = layer.getRows();
    return layers.flatMap((sublayer: any) =>
      sublayer.props.data.flatMap((object: any, index: number) => {
        const icon = sublayer.props.getIcon(object, info(index));
        return icon ? [[rows.indexOf(object.row ?? object), icon]] : [];
      })
    );
  };

  test('a stretchable icon is drawn as one stretched quad per part, in one layer', () => {
    const layer = labelLayer({...FIT_LAYOUT, 'icon-image': 'shield'}, [{name: 'abcd'}]);
    const iconLayers = layer.renderIconLayers();
    expect(iconLayers).toHaveLength(1);
    const [icons] = iconLayers;
    expect(icons).toBeInstanceOf(StretchIconLayer);
    expect(icons.id).toBe('labels-icons-fit-default');
    expect(icons.props.iconMapping).toBe(getStretchIconMapping(ATLAS));
    const row = layer.getRows()[0];
    expect(icons.props.data).toHaveLength(9);
    const drawn = icons.props.data.map((piece: any, index: number) => {
      const {getIcon, getSize, getIconStretch, getPixelOffset, getPosition, getPlacementSlot} =
        icons.props;
      // Each quad is drawn at its row's position, in its row's placement slot.
      expect(getPosition(piece, info(index))).toBe(row.position);
      expect(getPlacementSlot).toBe(layer.getPlacementSlotAccessor());
      return [
        getIcon(piece, info(index)),
        getSize(piece, info(index)),
        getIconStretch(piece, info(index)),
        getPixelOffset(piece, info(index))
      ];
    });
    // The fitted box is [-14, -7, 12, 9]: the corners keep 4 pixels, the middle stretches.
    expect(drawn[0]).toEqual([getIconPartName('shield', 0), 4, [1, 1], [-12, -5]]);
    expect(drawn[4]).toEqual([getIconPartName('shield', 4), 8, [18 / 8, 1], [-1, 1]]);
    expect(drawn[8]).toEqual([getIconPartName('shield', 8), 4, [1, 1], [10, 7]]);
  });

  test('overlapping icons are drawn whole, one after the other, not interleaved', () => {
    // Two shields at the same point, as with icon-allow-overlap and text-allow-overlap.
    const layer = labelLayer({...FIT_LAYOUT, 'icon-image': 'shield'}, [
      {name: 'abcd'},
      {name: 'efgh'}
    ]);
    const parts = Array.from({length: 9}, (_, part) => getIconPartName('shield', part));
    expect(getDrawOrder(layer, layer.renderIconLayers())).toEqual([
      ...parts.map(name => [0, name]),
      ...parts.map(name => [1, name])
    ]);
  });

  test("the placement slot of each quad is its row's", () => {
    const layer = labelLayer({...FIT_LAYOUT, 'icon-image': 'shield'}, [
      {name: 'abcd'},
      {name: 'efgh'}
    ]);
    layer.state.placementSlotBase = 10;
    const [icons] = layer.renderIconLayers();
    const slots = icons.props.data.map((piece: any, index: number) =>
      icons.props.getPlacementSlot(piece, info(index))
    );
    expect(slots).toEqual([...Array(9).fill(10), ...Array(9).fill(11)]);
  });

  test('an image without stretch zones is drawn whole, stretched to the fitted box', () => {
    const layer = labelLayer({...FIT_LAYOUT, 'icon-image': 'plain'}, [{name: 'abcd'}]);
    const [icons, ...rest] = layer.renderIconLayers();
    expect(rest).toEqual([]);
    const [piece] = icons.props.data;
    expect(icons.props.getIcon(piece, info(0))).toBe('plain');
    expect(icons.props.getSize(piece, info(0))).toBe(16);
    // 26 by 16 pixels from an image of aspect ratio 2.
    expect(icons.props.getIconStretch(piece, info(0))).toEqual([26 / 16 / 2, 1]);
    expect(icons.props.getPixelOffset(piece, info(0))).toEqual([-1, 1]);
  });

  test('a row without text draws its icon at its own size', () => {
    const layer = labelLayer({...FIT_LAYOUT, 'icon-image': 'shield'}, [{}, {name: 'abcd'}]);
    const iconLayers = layer.renderIconLayers();
    // `getRows` holds the rows reversed: the row without text is the second, drawn whole.
    const order = getDrawOrder(layer, iconLayers);
    expect(order).toHaveLength(10);
    expect(order[9]).toEqual([1, 'shield']);
    const {data, getSize, getIconStretch} = iconLayers[0].props;
    expect(getSize(data[9], info(9))).toBe(12);
    expect(getIconStretch(data[9], info(9))).toEqual([1, 1]);
  });

  test('the data is kept while the rows and parts stay the same', () => {
    const layer = labelLayer({...FIT_LAYOUT, 'icon-image': 'shield'}, [{name: 'abcd'}]);
    const [first] = layer.renderIconLayers();
    const [second] = layer.renderIconLayers();
    expect(second.props.data).toBe(first.props.data);
  });

  test('without icon-text-fit the icons are drawn by a plain IconLayer', () => {
    const layer = labelLayer({...FIT_LAYOUT, 'icon-text-fit': 'none', 'icon-image': 'shield'}, [
      {name: 'abcd'}
    ]);
    const iconLayers = layer.renderIconLayers();
    expect(iconLayers).toHaveLength(1);
    expect(iconLayers[0]).toBeInstanceOf(IconLayer);
    expect(iconLayers[0]).not.toBeInstanceOf(StretchIconLayer);
    expect(iconLayers[0].props.iconMapping).toBe(ATLAS.mapping);
  });

  test('the icon fits the text where text-anchor and text-offset put it', () => {
    const layout = {
      ...FIT_LAYOUT,
      'icon-image': 'shield',
      'icon-padding': 0,
      'icon-text-fit-padding': [0, 0, 0, 0],
      'text-anchor': 'top-left',
      // In ems of text-size 10.
      'text-offset': [1, 0.5]
    };
    expect(getIconBox(labelLayer(layout, [{name: 'abcd'}]))).toEqual([10, 5, 30, 17]);
  });

  test('the parts are kept while nothing they depend on changes, and made again at a new zoom', () => {
    const layer = labelLayer(
      {
        ...FIT_LAYOUT,
        'icon-image': 'plain',
        'icon-text-fit-padding': ['interpolate', ['linear'], ['zoom'], 8, ['literal', [0, 0, 0, 0]], 9, ['literal', [0, 10, 0, 10]]]
      },
      [{name: 'abcd'}]
    );
    const icons = layer.getRowIcons();
    const first = layer.getFittedIconParts(icons, 'both');
    expect(layer.getFittedIconParts(icons, 'both')).toBe(first);
    expect(first.parts[0][0].stretch[0]).toBeCloseTo(20 / 12 / 2, 12);
    // A copy that keeps the default props, which deck.gl holds on the props' prototype.
    layer.props = Object.assign(Object.create(Object.getPrototypeOf(layer.props)), layer.props, {
      zoom: 9
    });
    const next = layer.getFittedIconParts(icons, 'both');
    expect(next.revision).toBe(first.revision + 1);
    // 20 pixels wider.
    expect(next.parts[0][0].stretch[0]).toBeCloseTo(40 / 12 / 2, 12);
  });
});

describe('sprite stretch metadata', () => {
  test('is kept in the icon mapping', () => {
    expect(ATLAS.mapping.shield).toMatchObject({stretchX: [[4, 8]], stretchY: [[4, 8]]});
    const mapping = getSpriteIconMapping({
      label: {x: 0, y: 0, width: 20, height: 10, content: [2, 2, 18, 8], textFitWidth: 'proportional'}
    } as any);
    expect(mapping.label).toMatchObject({content: [2, 2, 18, 8], textFitWidth: 'proportional'});
  });

  test('an image whose metadata is invalid is left out, as MapLibre leaves it out', () => {
    const warn = vi.spyOn(log, 'warn').mockReturnValue(() => {});
    const mapping = getSpriteIconMapping({
      good: {x: 0, y: 0, width: 10, height: 10},
      bad: {x: 10, y: 0, width: 10, height: 10, stretchX: [[2, 12]]}
    } as any);
    expect(Object.keys(mapping)).toEqual(['good']);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test('the stretch mapping has an entry per part of each stretchable image, in the sprite', () => {
    const mapping = getStretchIconMapping(ATLAS);
    expect(mapping.plain).toBe(ATLAS.mapping.plain);
    expect(mapping[getIconPartName('plain', 0)]).toBeUndefined();
    const part = (index: number) => {
      const {x, y, width, height} = mapping[getIconPartName('shield', index)];
      return [x, y, width, height];
    };
    expect([0, 4, 8].map(part)).toEqual([
      [24, 0, 4, 4],
      [28, 4, 4, 4],
      [32, 8, 4, 4]
    ]);
    expect(mapping[getIconPartName('shield', 9)]).toBeUndefined();
  });
});

describe('StretchIconLayer shaders', () => {
  test('stretch the icon quad before it turns, in GLSL and in both WGSL variants', () => {
    const getShaders = (state: Record<string, unknown>) => {
      const layer: any = new StretchIconLayer({id: 'icons', data: []});
      layer.state = state;
      layer.context = {viewport: {}, defaultShaderModules: [], defaultShaderPlugins: []};
      return layer.getShaders();
    };
    const shaders = getShaders({});
    expect(shaders.vs).toContain('in vec2 instanceIconStretch;');
    expect(shaders.vs).toContain(
      'vec2 pixelOffset = positions / 2.0 * iconSize * instanceIconStretch + instanceOffsets;'
    );
    expect(shaders.source).toContain('@location(11) instanceIconStretch: vec2<f32>,');
    expect(shaders.source).toContain(
      'var pixelOffset = inp.positions / 2.0 * iconSize * inp.instanceIconStretch + inp.instanceOffsets;'
    );
    // Arrow columns draw the quad from the vertex index.
    expect(getShaders({columns: {}}).source).toContain(
      'var pixelOffset = quadPosition / 2.0 * iconSize * inp.instanceIconStretch + inp.instanceOffsets;'
    );
  });

  test('a shader that no longer matches throws', () => {
    expect(() => patchIconShader('void main() {}', STRETCH_ICON_SHADER_PATCHES.glsl)).toThrow(
      /no longer matches/
    );
  });
});
