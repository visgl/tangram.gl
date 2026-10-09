// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {ClassicWebGLRenderer, HostFrame} from '@vis.gl/tangram-renderer';
import type {HostFrameOptions, HostTileLODOptions, HostTileResourceOptions, TileResourceStatistics, RendererOptions, FeatureSelectionResult} from '@vis.gl/tangram-renderer';
import type {LumaLight, TangramLight, TangramPointLight, TangramLightMapping} from '@vis.gl/tangram-renderer';
import {convertLumaLight} from '@vis.gl/tangram-renderer/core';
import type {ProjectionEngine} from '@vis.gl/tangram-renderer/core';
import type {TangramLayerProps} from '@vis.gl/tangram-layers';
import {TangramLayer} from '@vis.gl/tangram-layers';

declare const projectionEngine: ProjectionEngine;
const projectedRendererOptions = {projectionEngine} satisfies RendererOptions;
const projectedLayerProperties = {id: 'projected', scene: 'projected.yaml', projectionEngine} satisfies TangramLayerProps;
ClassicWebGLRenderer.create('projected.yaml', projectedRendererOptions);
new TangramLayer(projectedLayerProperties);
// @ts-expect-error A single transform or unrelated object is not a ProjectionEngine factory.
new TangramLayer({scene: 'projected.yaml', projectionEngine: {projectSync: () => []}});

const frameOptions = {
  viewport: {width: 800, height: 600},
  geographicAnchor: {longitude: -74, latitude: 40.7, zoom: 12},
  projection: {type: 'web-mercator'},
  tileZoom: 10,
  renderViews: [
    {
      id: 'main',
      camera: {
        view: new Float64Array(16),
        projection: new Float32Array(16),
        position: [0, 0, 1] as const
      }
    }
  ]
} satisfies HostFrameOptions;

const rendererOptions = {requestRedraw: () => {}} satisfies RendererOptions;
const frame = new HostFrame(frameOptions);
const renderer = ClassicWebGLRenderer.create('scene.yaml', rendererOptions);

renderer.setFrame(frame);
const tileLOD = {targetTilePixels: 512, pixelRatio: 2, maxTiles: 256, hysteresis: 0.2} satisfies HostTileLODOptions;
renderer.setFrame({...frameOptions, tileZoom: undefined, tileLOD});
const tileResources = {maxConcurrentBuilds: 8, maxCachedTiles: 64, maxCachedMeshBytes: 32 * 1024 * 1024} satisfies HostTileResourceOptions;
renderer.setFrame({...frameOptions, tileResources});
const resources: TileResourceStatistics = renderer.getTileResourceStatistics();
void resources;
renderer.load();
const selected: Promise<FeatureSelectionResult | undefined> = renderer.getFeatureAt({x: 20, y: 40}, {radius: 6});
void selected;
const credits: Promise<string[]> = renderer.getAttributions();
const sceneCredits: Promise<string[]> = renderer.scene.getAttributions();
const lights: TangramLightMapping[] = renderer.getLumaLightDefinitions();
const light: LumaLight = {type: 'directional', direction: [0, 0, -1], color: [255, 255, 255]};
convertLumaLight(light);
const tangramLight: TangramLight = light;
const nativeLight: LumaLight = tangramLight;
const lamp = {type: 'point', position: [0, 0, 100], color: [255, 255, 255],
  ambient: 0.2, attenuation: [1, 0.01, 0], attenuationExponent: 2, radius: [null, '200m']
} satisfies TangramPointLight;
convertLumaLight(lamp);
void nativeLight;
void lights;
void credits;
void sceneCredits;
renderer.scene.updateConfig({rebuild: false});
renderer.scene.setDataSource('places', {type: 'GeoJSON', data: {type: 'FeatureCollection'}});
renderer.scene.queryFeatures({filter: {kind: 'place'}, geometry: true});
renderer.scene.screenshot({background: 'transparent'});
renderer.subscribe({
  load: event => event.config,
  error: event => event.error
});
