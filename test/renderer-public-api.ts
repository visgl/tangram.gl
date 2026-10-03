// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {ClassicWebGLRenderer, HostFrame} from '@vis.gl/tangram-renderer';
import type {HostFrameOptions, HostTileLODOptions, RendererOptions} from '@vis.gl/tangram-renderer';
import type {LumaLight, TangramLight, TangramPointLight, TangramLightMapping} from '@vis.gl/tangram-renderer';
import {convertLumaLight} from '@vis.gl/tangram-renderer/core';

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
renderer.load();
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
