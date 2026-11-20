// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/**
 * `heatmap` layers on a globe and in a projected view. On a globe the kernels lie on the sphere,
 * and the render is compared with MapLibre GL JS's globe. In a deck.gl `_CustomProjectionView`,
 * which MapLibre does not have, a kernel is drawn at the projected place of its point, with the
 * radius of MapLibre's kernel.
 */

import {afterEach, describe, expect, test} from 'vitest';
import {
  Deck,
  _CustomProjectionView as CustomProjectionView,
  _GlobeView as GlobeView,
  type Layer
} from '@deck.gl/core';
import {webgl2Adapter} from '@luma.gl/core/webgl';
import {BasemapLayer} from '../src/index';
import {setGeoJsonWorkerEnabled} from '../src/geojson-source';
import {renderMapLibre} from './reference-render/renderers';
import {VIEWPORT} from './reference-render/scenes';
import {
  CONUS_ALBERS_PROJ,
  getProjectedPixel,
  projectConusAlbers
} from '../../../test/projection-reference';

const SIZE = VIEWPORT.width;
const BACKGROUND = [0x1d, 0x27, 0x33];

let deck: Deck<any> | null = null;
let parent: HTMLDivElement | null = null;

afterEach(() => {
  deck?.finalize();
  deck = null;
  parent?.remove();
  parent = null;
});

/** Renders `layer` in `view` once its tiles are drawn, and returns the pixels on white. */
function render(layer: Layer, view: any, viewState: Record<string, unknown>) {
  parent = document.createElement('div');
  parent.style.cssText = `position: absolute; left: 0; top: 0; width: ${SIZE}px; height: ${SIZE}px;`;
  document.body.append(parent);
  let settled = 0;
  return new Promise<Uint8ClampedArray>((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error('Timed out rendering')), 60_000);
    deck = new Deck({
      parent: parent!,
      width: SIZE,
      height: SIZE,
      useDevicePixels: false,
      deviceProps: {adapters: [webgl2Adapter]},
      views: view,
      initialViewState: viewState as any,
      layers: [layer],
      onAfterRender: () => {
        const layers = (deck as any)?.layerManager?.getLayers() || [];
        const basemap = layers.find((candidate: any) => candidate.id === 'basemap');
        const tileLayers = layers.filter((candidate: any) => candidate.state?.tileset);
        if (
          !basemap?.state?.resolvedStyle ||
          tileLayers.length === 0 ||
          tileLayers.some((candidate: any) => !candidate.state.tileset.selectedTiles) ||
          layers.some((candidate: any) => !candidate.isLoaded)
        ) {
          settled = 0;
          return;
        }
        if (settled++ < 4) {
          deck!.redraw('settle');
          return;
        }
        const copy = document.createElement('canvas');
        copy.width = SIZE;
        copy.height = SIZE;
        const context = copy.getContext('2d')!;
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, SIZE, SIZE);
        context.drawImage(deck!.getCanvas()!, 0, 0);
        window.clearTimeout(timeout);
        resolve(context.getImageData(0, 0, SIZE, SIZE).data);
      },
      onError: error => {
        window.clearTimeout(timeout);
        reject(error);
      }
    });
  });
}

function isColored(pixels: Uint8ClampedArray, index: number): boolean {
  return (
    Math.abs(pixels[index] - BACKGROUND[0]) +
      Math.abs(pixels[index + 1] - BACKGROUND[1]) +
      Math.abs(pixels[index + 2] - BACKGROUND[2]) >
    6
  );
}

function getStyle(features: unknown[], paint: Record<string, unknown>, globe = false): any {
  return {
    version: 8,
    ...(globe ? {projection: {type: 'globe'}} : {}),
    sources: {points: {type: 'geojson', data: {type: 'FeatureCollection', features}}},
    layers: [
      {id: 'background', type: 'background', paint: {'background-color': '#1d2733'}},
      {id: 'heatmap', type: 'heatmap', source: 'points', paint}
    ]
  };
}

function point(coordinates: number[]) {
  return {type: 'Feature', properties: {}, geometry: {type: 'Point', coordinates}};
}

describe('heatmap on a globe', () => {
  // MapLibre scales the kernels of a globe by the view center's latitude.
  test.each([0, 50])('draws on the sphere as MapLibre GL JS does, centered at latitude %d', async latitude => {
    // Two clusters of points at the view center and one off it, where the sphere is turned.
    const features = [];
    for (let index = 0; index < 60; index++) {
      const angle = index * 2.39996;
      const distance = 3 * Math.sqrt(index / 60);
      features.push(point([distance * Math.cos(angle) - 4, distance * Math.sin(angle) + 2 + latitude]));
      if (index % 3 === 0) {
        features.push(point([distance * Math.cos(angle) + 22, distance * Math.sin(angle) - 18 + latitude]));
      }
    }
    const style = getStyle(features, {'heatmap-radius': 25, 'heatmap-intensity': 0.4}, true);
    const scene = {id: 'heatmap-globe', style: 'ofm-positron', center: [0, latitude], zoom: 2.5};
    const reference = (await renderMapLibre(structuredClone(style), scene as any)).pixels;
    const candidate = await render(
      new BasemapLayer({id: 'basemap', style: structuredClone(style), mode: 'globe'}),
      new GlobeView({resolution: 10} as any),
      {longitude: 0, latitude, zoom: 2.5}
    );

    let colored = 0;
    let both = 0;
    const differences: number[] = [];
    for (let index = 0; index < reference.length; index += 4) {
      const inReference = isColored(reference, index);
      const inCandidate = isColored(candidate, index);
      if (inReference || inCandidate) {
        colored++;
        if (inReference && inCandidate) {
          both++;
        }
        let difference = 0;
        for (let channel = 0; channel < 3; channel++) {
          difference += Math.abs(reference[index + channel] - candidate[index + channel]);
        }
        differences.push(difference);
      }
    }
    differences.sort((a, b) => a - b);
    expect(colored, 'pixels either renderer colors').toBeGreaterThan(10_000);
    expect(both / colored, 'share of colored pixels both color').toBeGreaterThan(0.95);
    expect(differences[Math.floor(colored / 2)], 'median difference').toBeLessThanOrEqual(3);
    expect(differences[Math.floor(colored * 0.9)], '90th percentile difference').toBeLessThan(30);
  }, 120_000);
});

describe('heatmap in a projected view', () => {
  test('draws a kernel at the projected place of its point', async () => {
    setGeoJsonWorkerEnabled(false);
    const center = [-80, 40];
    const lngLat = [-79.97, 40.01];
    const radius = 20;
    // Colored where the density is at least 0.01: a disc of radius 0.908 * `heatmap-radius`.
    const style = getStyle([point(lngLat)], {
      'heatmap-radius': radius,
      'heatmap-color': ['step', ['heatmap-density'], 'rgba(0, 0, 0, 0)', 0.01, '#ff0000']
    });
    const view = {center, zoom: 9, width: SIZE, height: SIZE};
    const pixels = await render(
      new BasemapLayer({id: 'basemap', style}),
      new CustomProjectionView({id: 'projected', crs: CONUS_ALBERS_PROJ} as any),
      {center: [center[0], center[1], 0], zoom: view.zoom}
    );
    let count = 0;
    let sumX = 0;
    let sumY = 0;
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const index = (y * SIZE + x) * 4;
        if (pixels[index] > 200 && pixels[index + 1] < 60) {
          count++;
          sumX += x + 0.5;
          sumY += y + 0.5;
        }
      }
    }
    const [expectedX, expectedY] = getProjectedPixel(projectConusAlbers, lngLat, view);
    const expectedArea = Math.PI * (radius * Math.sqrt(Math.log(0.3989422804014327 / 0.01) / 4.5)) ** 2;
    expect(Math.abs(count - expectedArea) / expectedArea).toBeLessThan(0.1);
    expect(Math.abs(sumX / count - expectedX)).toBeLessThan(1.5);
    expect(Math.abs(sumY / count - expectedY)).toBeLessThan(1.5);
  }, 120_000);
});
