// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {FirstPersonViewport, WebMercatorViewport} from '@deck.gl/core';
import {Matrix4} from '@math.gl/core';
import {projectGeographicPosition} from '@vis.gl/tangram-renderer/core';
import {describe, expect, test} from 'vitest';
import WebMercatorViewAdapter from '../src/web_mercator_view_adapter';
import {WebXRMapView, WebXRFirstPersonView} from '../src/experimental/webxr/views';
import {WebXRPresentation} from '../src/experimental/webxr/presentation';

/** Project an absolute meter position through the renderer's public camera contract. */
function projectCamera(position: [number, number, number], camera: {view: ArrayLike<number>; projection: ArrayLike<number>}, width: number, height: number) {
  const clip = new Matrix4(Array.from(camera.projection)).multiplyRight(new Matrix4(Array.from(camera.view))).transform([ ...position, 1]);
  return [(clip[0] / clip[3] + 1) * width / 2, (1 - clip[1] / clip[3]) * height / 2];
}

describe('public deck projection conformance', () => {
  test.each([0, 40.7, 75])('map and first-person meter cameras match deck.project at latitude %s', latitude => {
    for (const viewport of [
      new WebMercatorViewport({width: 800, height: 600, longitude: 179.99, latitude, zoom: 18, pitch: 60, bearing: 35}),
      new FirstPersonViewport({width: 800, height: 600, longitude: 179.99, latitude, position: [0, 0, 600], pitch: 60, bearing: 35, far: 20000})
    ]) {
      const camera = WebMercatorViewAdapter.getCameraFrame(viewport);
      const original = Array.from(viewport.viewMatrix);
      for (const geographic of [[179.99001, latitude + 0.00001, 25], [179.99002, latitude, 0]] as [number, number, number][]) {
        const pixels = projectCamera(projectGeographicPosition(geographic, 'web-mercator', viewport.longitude), camera, viewport.width, viewport.height);
        const expected = viewport.project(geographic);
        pixels.forEach((pixel, index) => expect(pixel).toBeCloseTo(expected[index], 3));
      }
      expect(camera.view).toBeInstanceOf(Float64Array);
      expect(Array.from(viewport.viewMatrix)).toEqual(original);
    }
  });

  test.each([WebXRMapView, WebXRFirstPersonView])('each stereo eye preserves its public viewport projection: %s', ViewClass => {
    const presentation = new WebXRPresentation({view: new ViewClass({id: 'view'}), mode: 'stereo-preview',
      viewState: {longitude: -74, latitude: 40.7, zoom: 16, pitch: 60, bearing: 20, position: [0, 0, 600]}});
    try {
      const frame = presentation.createFrame({width: 800, height: 400, interpupillaryDistance: 0.064});
      expect(frame.renderViews).toHaveLength(2);
      const geographic: [number, number, number] = [-73.9999, 40.7001, 30];
      const meters = projectGeographicPosition(geographic, 'web-mercator', -74);
      for (const [index, eye] of frame.renderViews.entries()) {
        const camera = frame.hostFrame.renderViews![index].camera!;
        // Stereo adds a camera-right translation and off-axis projection to the
        // public logical viewport, not a geographic east offset or toe-in rotation.
        const baseCamera = WebMercatorViewAdapter.getCameraFrame(eye.deckViewport);
        const common = eye.deckViewport.projectPosition(geographic);
        const eyePosition = new Matrix4(eye.deckViewport.viewMatrix).transform([...common, 1]);
        eyePosition[0] += camera.view[12] - baseCamera.view[12];
        const clip = new Matrix4(Array.from(camera.projection)).transform(eyePosition);
        const expected = [(clip[0] / clip[3] + 1) * eye.deckViewport.width / 2,
          (1 - clip[1] / clip[3]) * eye.deckViewport.height / 2];
        const actual = projectCamera(meters, camera, eye.deckViewport.width, eye.deckViewport.height);
        actual.forEach((pixel, axis) => expect(pixel).toBeCloseTo(expected[axis], 3));
      }
    } finally { presentation.finalize(); }
  });
});
