// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {describe, expect, test} from 'vitest';
import {getBasemapLayers} from '../src/globe-layers';
import {FillPatternExtension} from '../src/fill-style-extensions';
import type {SpriteAtlas} from '../src/sprite';

const SPRITE: SpriteAtlas = {
  id: 'default',
  // An image object, not a URL: deck.gl resolves a URL prop only once the layer loads it.
  image: {name: 'sprite image'} as any,
  mapping: {
    paper: {x: 0, y: 0, width: 32, height: 16, mask: false, pixelRatio: 2},
    grass: {x: 32, y: 0, width: 8, height: 8, mask: false, pixelRatio: 1}
  }
};

function getBackground(
  paint: Record<string, unknown>,
  {
    zoom = 3.25,
    spriteAtlases = [SPRITE],
    mode = 'map'
  }: {zoom?: number; spriteAtlases?: SpriteAtlas[] | null; mode?: 'map' | 'globe'} = {}
): any {
  const layers = getBasemapLayers({
    idPrefix: 'test',
    mode,
    zoom,
    spriteAtlases,
    styleDefinition: {
      version: 8,
      sources: {},
      layers: [{id: 'background', type: 'background', paint}]
    } as any
  });
  return layers.find((layer: any) => layer.id.startsWith('test-background'));
}

describe('background-pattern', () => {
  test('draws the sprite image, at its CSS-pixel size at the integer zoom', () => {
    const background = getBackground({'background-pattern': 'paper'});
    expect(background.props.extensions.some((e: any) => e instanceof FillPatternExtension)).toBe(
      true
    );
    expect(background.props.getFillPattern).toBe('paper');
    expect(background.props.fillPatternSizeUnits).toBe('common');
    // A pixel ratio of 2: half an image pixel per CSS pixel, at zoom 3.
    expect(background.props.getFillPatternScale).toBe(2 ** -3 / 2);
    // The image supplies the colors.
    expect(background.props.getFillColor).toEqual([255, 255, 255, 255]);
  });

  test('takes its opacity from background-opacity, not background-color', () => {
    const background = getBackground({
      'background-pattern': 'paper',
      'background-color': '#ff0000',
      'background-opacity': 0.5
    });
    expect(background.props.getFillColor).toEqual([255, 255, 255, 128]);
  });

  test('evaluates a zoom-dependent image at the integer zoom', () => {
    const paint = {'background-pattern': ['step', ['zoom'], 'paper', 4, 'grass']};
    expect(getBackground(paint, {zoom: 3.75}).props.getFillPattern).toBe('paper');
    expect(getBackground(paint, {zoom: 4}).props.getFillPattern).toBe('grass');
  });

  test('draws nothing while the sprites load, or without the image', () => {
    for (const background of [
      getBackground({'background-pattern': 'paper'}, {spriteAtlases: null}),
      getBackground({'background-pattern': 'missing'})
    ]) {
      expect(background.props.getFillColor).toEqual([0, 0, 0, 0]);
      expect(background.props.extensions ?? []).toEqual([]);
    }
  });

  test('draws on a globe', () => {
    const background = getBackground({'background-pattern': 'paper'}, {mode: 'globe'});
    expect(background.props.getFillPattern).toBe('paper');
    expect(background.props.getFillColor).toEqual([255, 255, 255, 255]);
  });
});
