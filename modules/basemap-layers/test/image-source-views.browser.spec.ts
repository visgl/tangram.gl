// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {
  Deck,
  MapView,
  _CustomProjectionView as CustomProjectionView,
  _GlobeView as GlobeView
} from '@deck.gl/core';
import {webgl2Adapter} from '@luma.gl/core/webgl';
import {afterEach, describe, expect, test} from 'vitest';
import {BasemapLayer} from '../src/basemap-layer';
import {getImageWarp, warpImagePoint, type ImageSourceCorners} from '../src/image-source-layer';
import {lngLatToMercatorWorld, mercatorWorldToLngLat} from '../src/projected-viewport';
import {getProjectedPixel, projectUtm32N} from '../../../test/projection-reference';
import {FIXTURE_ROOT} from './reference-render/fixtures';

// An image source draws on a globe and in a projected view as on a map: each quadrant of the
// image lands where the warp puts it. `reference-render/image-source.browser.spec.ts` compares
// the map with MapLibre GL JS pixel by pixel.

const SIZE = 384;
const BACKGROUND = [242, 239, 233];
/** The colors of the image's quadrants, and a point inside each, `[u, v]` from the top left. */
const QUADRANTS: {color: number[]; point: [number, number]}[] = [
  {color: [214, 64, 52], point: [0.3, 0.15]},
  {color: [66, 160, 90], point: [0.75, 0.25]},
  {color: [48, 92, 196], point: [0.75, 0.75]},
  {color: [232, 196, 60], point: [0.25, 0.75]}
];

/** A quad that is not a rectangle, around `center`, top left first. */
function getCorners([longitude, latitude]: number[]): ImageSourceCorners {
  return [
    [longitude - 1.1, latitude + 1.3],
    [longitude + 1.4, latitude + 0.9],
    [longitude + 0.8, latitude - 1.2],
    [longitude - 1.3, latitude - 0.7]
  ];
}

/** The same corners listed counterclockwise, which mirrors the image. */
function mirror([topLeft, topRight, bottomRight, bottomLeft]: ImageSourceCorners) {
  return [topRight, topLeft, bottomLeft, bottomRight] as ImageSourceCorners;
}

function getStyle(corners: ImageSourceCorners) {
  return {
    version: 8,
    sources: {
      overlay: {
        type: 'image',
        url: `${location.origin}/${FIXTURE_ROOT}/image-source/quadrants.png`,
        coordinates: corners
      }
    },
    layers: [
      {id: 'background', type: 'background', paint: {'background-color': `rgb(${BACKGROUND})`}},
      {id: 'overlay', type: 'raster', source: 'overlay', paint: {'raster-resampling': 'nearest'}}
    ]
  };
}

type Kind = 'map' | 'globe' | 'projected';

const CENTERS: Record<Kind, [number, number]> = {
  map: [0, 0],
  globe: [20, 45],
  projected: [10.5, 48]
};
const ZOOM = 6;

let deck: Deck<any> | null = null;
let parent: HTMLDivElement | null = null;

afterEach(() => {
  deck?.finalize();
  deck = null;
  parent?.remove();
  parent = null;
});

/** The pixels of the basemap drawn in a view of `kind`, and the viewport, once loaded. */
function render(kind: Kind, corners: ImageSourceCorners) {
  parent = document.createElement('div');
  document.body.append(parent);
  const [longitude, latitude] = CENTERS[kind];
  const view =
    kind === 'globe'
      ? new GlobeView({id: 'view', resolution: 5})
      : kind === 'projected'
        ? new CustomProjectionView({id: 'view', crs: 'EPSG:32632'})
        : new MapView({id: 'view'});
  const viewState =
    kind === 'projected'
      ? {center: [longitude, latitude, 0], zoom: ZOOM}
      : {longitude, latitude, zoom: ZOOM, pitch: 0, bearing: 0};
  return new Promise<{pixels: Uint8ClampedArray; viewport: any}>((resolve, reject) => {
    let settled = 0;
    const timeout = window.setTimeout(() => reject(new Error('Timed out rendering')), 60_000);
    deck = new Deck({
      parent: parent!,
      width: SIZE,
      height: SIZE,
      useDevicePixels: false,
      deviceProps: {adapters: [webgl2Adapter]},
      views: view,
      viewState: viewState as any,
      layers: [
        new BasemapLayer({
          id: 'basemap',
          mode: kind === 'globe' ? 'globe' : 'map',
          style: getStyle(corners) as any
        })
      ],
      onAfterRender: () => {
        const layers = (deck as any)?.layerManager?.getLayers() || [];
        const basemap = layers.find((layer: any) => layer.id === 'basemap');
        if (!basemap?.state?.resolvedStyle || layers.some((layer: any) => !layer.isLoaded)) {
          return;
        }
        if (settled++ < 2) {
          window.requestAnimationFrame(() => deck?.redraw('settle'));
          return;
        }
        window.clearTimeout(timeout);
        const copy = document.createElement('canvas');
        copy.width = SIZE;
        copy.height = SIZE;
        const context = copy.getContext('2d')!;
        context.drawImage(deck!.getCanvas()!, 0, 0);
        resolve({
          pixels: context.getImageData(0, 0, SIZE, SIZE).data,
          viewport: deck!.getViewports()[0]
        });
      },
      onError: error => reject(error)
    });
  });
}

/** Where a point of the image is drawn, in pixels. */
function getImagePixel(kind: Kind, viewport: any, corners: ImageSourceCorners, [u, v]: number[]) {
  const world = corners.map(corner => lngLatToMercatorWorld(corner));
  const lngLat = mercatorWorldToLngLat(warpImagePoint(world, getImageWarp(corners), u, v));
  if (kind === 'projected') {
    return getProjectedPixel(projectUtm32N, lngLat, {
      center: CENTERS.projected,
      zoom: ZOOM,
      width: SIZE,
      height: SIZE
    });
  }
  return viewport.project(lngLat) as number[];
}

function getPixel(pixels: Uint8ClampedArray, [x, y]: number[]): number[] {
  const offset = (Math.round(y) * SIZE + Math.round(x)) * 4;
  return [pixels[offset], pixels[offset + 1], pixels[offset + 2]];
}

describe('image source views', () => {
  test.each([
    {kind: 'map', mirrored: false},
    {kind: 'globe', mirrored: false},
    {kind: 'globe', mirrored: true},
    {kind: 'projected', mirrored: false}
  ] as const)('$kind, mirrored: $mirrored', async ({kind, mirrored}) => {
    const corners = getCorners(CENTERS[kind]);
    const drawn = mirrored ? mirror(corners) : corners;
    const {pixels, viewport} = await render(kind, drawn);
    for (const {color, point} of QUADRANTS) {
      const pixel = getImagePixel(kind, viewport, drawn, point);
      expect(pixel[0]).toBeGreaterThan(0);
      expect(pixel[0]).toBeLessThan(SIZE);
      expect(pixel[1]).toBeGreaterThan(0);
      expect(pixel[1]).toBeLessThan(SIZE);
      const actual = getPixel(pixels, pixel);
      for (let channel = 0; channel < 3; channel++) {
        expect(Math.abs(actual[channel] - color[channel]), `${color} at ${pixel}`).toBeLessThan(6);
      }
    }
  }, 90_000);
});
