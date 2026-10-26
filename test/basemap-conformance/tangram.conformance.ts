// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/**
 * tangram.gl's runner of the shared basemap conformance corpus (deck.gl-community
 * `dev/basemap-conformance`): renders the scenes of the Streets comparison style with
 * `TangramLayer` (the Streets example scene, on the corpus's recorded tiles) in a deck.gl `MapView`,
 * and with this repository's MapLibre GL JS. The shared scorer compares each render with the
 * `maplibre` reference render. Report only: a test fails when a render is not a valid measurement,
 * never on its scores. See `vitest.conformance.config.ts` and `scripts/basemap-conformance.mjs`.
 *
 * Renderers (VITE_CONFORMANCE_RENDERERS, default `maplibre,tangram`):
 * - `tangram`: `TangramLayer`.
 * - `maplibre`: this repository's MapLibre as the reference, in the same browser and on the same GPU.
 * - `maplibre@tangram`: the same MapLibre under another id, for when deck.gl-community's runner has
 *   rendered the `maplibre` reference (`yarn conformance:reference`). The scorer then reports how
 *   far the two repositories' references are apart.
 */

import {Deck, MapView, type Layer, type LayerProps} from '@deck.gl/core';
import {luma, type Device} from '@luma.gl/core';
import {webgl2Adapter} from '@luma.gl/webgl';
import {expression, latest} from '@maplibre/maplibre-gl-style-spec';
import * as maplibregl from 'maplibre-gl';
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import {TangramLayer} from '@vis.gl/tangram-layers';
import {describe, expect, test} from 'vitest';
import tangramLayersPackage from '../../modules/tangram-layers/package.json';
import {
  VIEWPORT,
  createContainer,
  createMapLibreRenderer,
  readCanvas,
  runConformanceScene,
  selectScenes,
  withTimeout,
  type ConformanceRenderer,
  type ConformanceScene
} from 'basemap-conformance';
import {createVectorSource} from '../../examples/classic/app/vector-providers.js';
import {createComparisonStyle} from '../../examples/deck/comparison-style';
import {createStreetsScene} from '../../examples/deck/streets-scene';

maplibregl.setWorkerUrl(maplibreWorkerUrl);

const env = (import.meta as {env?: Record<string, string | undefined>}).env || {};
const SCENES = selectScenes(env.VITE_CONFORMANCE_SCENES || 'tangram-streets');
const RENDERERS = (env.VITE_CONFORMANCE_RENDERERS || 'maplibre,tangram').split(',').map(id => id.trim());
/** The commit under test, for the report (CI sets it). */
const REVISION = env.VITE_CONFORMANCE_REVISION;
/** The corpus style that `TangramLayer` maps to the Streets example scene. */
const STREETS_STYLE = 'tangram-streets';
/** Grid step of the label read-back, in CSS pixels: each probe reads a block this size. */
const LABEL_PROBE_STEP = 8;
/** Frames, and at least this long, that the scene must stay complete before it is read: label fade-in is 0.15 s. */
const SETTLE_FRAMES = 10;
const SETTLE_MS = 500;

type RuntimeScene = {
  view_complete: boolean;
  building: unknown;
  updating: number;
  tile_manager: {isLoadingVisibleTiles(): boolean; allVisibleTilesLabeled(): boolean};
};
type TangramRecord = {loaded: boolean; loadFailed: boolean; scene?: RuntimeScene};
type FixtureLayerProps = {scene: unknown; onSceneError: (error: Error) => void};
type TangramLayerInstance = Layer & {
  state: {tangramRecord?: TangramRecord};
  getFeatureAt(pixel: {x: number; y: number}, options?: {radius?: number}): Promise<
    {feature?: {properties?: Record<string, unknown>} | null; error?: unknown} | undefined
  >;
};
const FixtureLayer = TangramLayer as unknown as new (properties: FixtureLayerProps & LayerProps) => Layer;

/** The Streets example scene, reading the corpus's tiles instead of the live provider. */
function createSceneFor(style: any) {
  const source = style.sources.basemap;
  return createStreetsScene({
    vectorSource: {...createVectorSource('openfreemap'), url: source.tiles[0], tilejson: '', max_zoom: source.maxzoom ?? 14},
    fontUrl: new URL('../../examples/classic/fonts/montserrat.woff', import.meta.url).href,
    labels: true,
    interactiveLabels: true
  });
}

/**
 * Checks that the corpus's Streets style is the output of `createComparisonStyle`, as the corpus
 * README says. Otherwise `TangramLayer` and MapLibre draw different cartography, and the render is
 * not a valid measurement: the current style is saved to the output for a new corpus export.
 */
async function checkCorpusStyle(): Promise<string | null> {
  const corpus = await (await fetch('/__conformance__/fixtures/styles/tangram-streets.json')).json();
  const current = createComparisonStyle('streetsVector', 'mapFlat', 'openfreemap', {labels: true});
  if (JSON.stringify(corpus) === JSON.stringify(current)) {
    return null;
  }
  await fetch('/__conformance__/output/tangram-streets.json', {method: 'POST', body: `${JSON.stringify(current, null, 2)}\n`});
  return 'The corpus style is not createComparisonStyle(\'streetsVector\', \'mapFlat\', \'openfreemap\', {labels: true}): ' +
    'export tangram-streets.json from the output to the corpus';
}

function isComplete(layer: TangramLayerInstance | undefined): boolean {
  const record = layer?.state?.tangramRecord;
  const scene = record?.scene;
  return Boolean(
    record?.loaded && scene && scene.view_complete && !scene.building && scene.updating === 0 &&
      !scene.tile_manager.isLoadingVisibleTiles() && scene.tile_manager.allVisibleTilesLabeled()
  );
}

/**
 * The names of the place labels Tangram drew: its feature selection buffer, probed on a grid. Hidden
 * (collided) labels collapse to degenerate triangles in every pass, the selection pass included, so
 * only placed labels can be hit. A probe reads a `LABEL_PROBE_STEP` block and returns the feature
 * at its center or the nearest one, so every label at least that wide and tall is found.
 */
async function readPlacedLabels(layer: TangramLayerInstance): Promise<{labels: string[]; errors: string[]}> {
  const labels = new Set<string>();
  const errors: string[] = [];
  const probes: Array<Promise<void>> = [];
  for (let y = LABEL_PROBE_STEP / 2; y < VIEWPORT.height; y += LABEL_PROBE_STEP) {
    for (let x = LABEL_PROBE_STEP / 2; x < VIEWPORT.width; x += LABEL_PROBE_STEP) {
      probes.push(layer.getFeatureAt({x, y}, {radius: LABEL_PROBE_STEP / 2}).then(result => {
        if (result?.error) errors.push(String(result.error));
        const name = result?.feature?.properties?.name;
        if (typeof name === 'string' && name) labels.add(name);
      }));
    }
  }
  await Promise.all(probes);
  return {labels: [...labels], errors: [...new Set(errors)]};
}

async function createDevice(canvas: HTMLCanvasElement): Promise<Device> {
  // The settings of tangram.gl's rendering harness (`test/rendering/harness.ts`).
  return luma.createDevice({
    type: 'webgl',
    adapters: [webgl2Adapter],
    createCanvasContext: {canvas, useDevicePixels: false},
    webgl: {preserveDrawingBuffer: true, antialias: false, depth: true, stencil: true}
  });
}

const tangramRenderer: ConformanceRenderer = {
  id: 'tangram',
  name: `TangramLayer ${tangramLayersPackage.version}${REVISION ? ` (${REVISION})` : ''}`,
  supports: (scene: ConformanceScene) => scene.style === STREETS_STYLE,
  async render(scene, style) {
    const styleDrift = await checkCorpusStyle();
    const container = createContainer();
    const canvas = document.createElement('canvas');
    canvas.width = VIEWPORT.width;
    canvas.height = VIEWPORT.height;
    canvas.style.cssText = `width: ${VIEWPORT.width}px; height: ${VIEWPORT.height}px; display: block;`;
    container.append(canvas);
    const problems: string[] = styleDrift ? [styleDrift] : [];
    const start = performance.now();
    performance.clearResourceTimings();
    const device = await createDevice(canvas);
    device.getDefaultCanvasContext().setDrawingBufferSize(VIEWPORT.width, VIEWPORT.height);
    let deck: Deck<MapView> | null = null;
    try {
      let completeFrames = 0;
      let completeSince = 0;
      let frames = 0;
      const pixels = await withTimeout(new Promise<Uint8ClampedArray>((resolve, reject) => {
        deck = new Deck({
          canvas, device, width: VIEWPORT.width, height: VIEWPORT.height, useDevicePixels: false,
          views: new MapView(),
          initialViewState: {longitude: scene.center[0], latitude: scene.center[1], zoom: scene.zoom,
            pitch: scene.pitch ?? 0, bearing: scene.bearing ?? 0},
          // Tangram's label placement and selection pass run in the host's frames.
          _animate: true,
          onError: error => {problems.push(`deck.gl: ${error.message}`);},
          layers: [new FixtureLayer({id: 'tangram', scene: createSceneFor(style),
            onSceneError: (error: Error) => problems.push(`Tangram: ${error.message}`)})],
          onAfterRender: () => {
            frames++;
            const layer = (deck as any)?.layerManager?.getLayers({layerIds: ['tangram']})[0];
            if (layer?.state?.tangramRecord?.loadFailed) {
              reject(new Error(`Tangram scene failed to load: ${problems.join('; ')}`));
              return;
            }
            if (!isComplete(layer)) {
              completeFrames = 0;
              return;
            }
            if (completeFrames++ === 0) completeSince = performance.now();
            if (completeFrames >= SETTLE_FRAMES && performance.now() - completeSince >= SETTLE_MS) {
              resolve(readCanvas(canvas));
            }
          }
        });
      }), 'TangramLayer render', 240_000);
      const renderMs = performance.now() - start;
      const layer = (deck as any).layerManager.getLayers({layerIds: ['tangram']})[0] as TangramLayerInstance;
      const labelStart = performance.now();
      const {labels, errors} = await withTimeout(readPlacedLabels(layer), 'Tangram label read-back', 120_000);
      problems.push(...errors.map(error => `Label read-back: ${error}`));
      if (!isComplete(layer)) problems.push('The scene changed during label read-back');
      for (const entry of performance.getEntriesByType('resource')) {
        if (!entry.name.startsWith(location.origin) && !entry.name.startsWith('data:')) {
          problems.push(`Off-origin request: ${entry.name}`);
        }
      }
      return {
        pixels, width: VIEWPORT.width, height: VIEWPORT.height, labels,
        labelNote: `Feature selection buffer probed every ${LABEL_PROBE_STEP} px; place names only (the only text layer)`,
        problems,
        meta: {renderMs: Math.round(renderMs), labelReadbackMs: Math.round(performance.now() - labelStart),
          frames, device: device.type}
      };
    } finally {
      (deck as Deck<MapView> | null)?.finalize();
      device.destroy();
      container.remove();
    }
  }
};

const maplibreDependencies = {maplibregl, styleSpec: {expression, latest}};
const crossCheckRenderer = createMapLibreRenderer(maplibreDependencies, 'maplibre@tangram');
const renderers = [
  createMapLibreRenderer(maplibreDependencies),
  {...crossCheckRenderer, name: `${crossCheckRenderer.name} (tangram.gl)`},
  tangramRenderer
].filter(renderer => RENDERERS.includes(renderer.id));
const unknownRenderers = RENDERERS.filter(id => !renderers.some(renderer => renderer.id === id));
if (unknownRenderers.length) {
  throw new Error(`Unknown conformance renderers: ${unknownRenderers.join(', ')}`);
}

for (const renderer of renderers) {
  describe(`conformance: ${renderer.name}`, () => {
    test.each(SCENES.filter(scene => renderer.supports(scene)))('$id', async scene => {
      const saved = await runConformanceScene(renderer, scene);
      expect(saved.fixtureMisses, 'missing fixtures: run with CONFORMANCE_RECORD=1').toEqual([]);
      expect(saved.problems, 'the render is not a valid measurement').toEqual([]);
    }, 400_000);
  });
}
