// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {MapView, _GlobeView as GlobeView, type View} from '@deck.gl/core';
import {describe, expect, test} from 'vitest';
import {
  type BackendPaintTestOptions,
  createBackendRenderer,
  SIZE,
  vectorTile
} from './backend-paint-tests';

/**
 * The tests of `line-translate`, `fill-extrusion-translate` and `circle-translate`, with their
 * anchors, for one GPU backend. The browser suite of this module runs them on WebGL, and the
 * rendering suite on WebGL and WebGPU.
 */

const CENTER = SIZE / 2;
const ZOOM = 5;
const DEGREES_PER_PIXEL = 360 / (512 * 2 ** ZOOM);

/** The centroid and bounds of the drawn pixels. */
function getFootprint(image: ImageData): {centroid: [number, number]; width: number; height: number} {
  let x = 0;
  let y = 0;
  let count = 0;
  let left = image.width;
  let right = -1;
  let top = image.height;
  let bottom = -1;
  for (let row = 0; row < image.height; row++) {
    for (let column = 0; column < image.width; column++) {
      const i = (row * image.width + column) * 4;
      if (image.data[i] + image.data[i + 1] + image.data[i + 2] < 384) {
        x += column + 0.5;
        y += row + 0.5;
        count++;
        left = Math.min(left, column);
        right = Math.max(right, column);
        top = Math.min(top, row);
        bottom = Math.max(bottom, row);
      }
    }
  }
  expect(count, 'pixels drawn').toBeGreaterThan(20);
  return {
    centroid: [x / count, y / count],
    width: right - left + 1,
    height: bottom - top + 1
  };
}

function expectMoved(
  [x, y]: [number, number],
  plain: [number, number],
  [dx, dy]: [number, number],
  tolerance = 1
) {
  const message = `centroid ${x.toFixed(2)}, ${y.toFixed(2)}; plain ${plain.join(', ')}`;
  expect(Math.abs(x - (plain[0] + dx)), message).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(y - (plain[1] + dy)), message).toBeLessThanOrEqual(tolerance);
}

const feature = (geometry: object) => ({type: 'Feature', geometry, properties: {}});

/** A line through the canvas center, from the south west to the north east. */
const LINE = feature({
  type: 'LineString',
  coordinates: [
    [-0.6, -0.4],
    [0.6, 0.4]
  ]
});
const POINT = feature({type: 'Point', coordinates: [0, 0]});
const SQUARE = feature({
  type: 'Polygon',
  coordinates: [
    [
      [-0.8, -0.8],
      [0.8, -0.8],
      [0.8, 0.8],
      [-0.8, 0.8],
      [-0.8, -0.8]
    ]
  ]
});

type TranslateCase = {
  type: 'line' | 'circle' | 'fill-extrusion';
  feature: unknown;
  paint: Record<string, unknown>;
};

const CASES: (TranslateCase & {name: string})[] = [
  {name: 'line', type: 'line', feature: LINE, paint: {'line-color': '#000000', 'line-width': 6}},
  {
    name: 'circle (viewport)',
    type: 'circle',
    feature: POINT,
    paint: {'circle-color': '#000000', 'circle-radius': 8}
  },
  {
    name: 'circle (map)',
    type: 'circle',
    feature: POINT,
    paint: {'circle-color': '#000000', 'circle-radius': 8, 'circle-pitch-alignment': 'map'}
  },
  {
    name: 'fill-extrusion',
    type: 'fill-extrusion',
    feature: SQUARE,
    paint: {
      'fill-extrusion-color': '#000000',
      'fill-extrusion-height': 1000,
      'fill-extrusion-vertical-gradient': false
    }
  }
];

/** Registers the translate tests for one GPU backend. */
export function defineTranslateTests(options: BackendPaintTestOptions): void {
  const {deviceType} = options;
  const draw = createBackendRenderer(options);
  const render = (
    {type, feature: shape, paint}: TranslateCase,
    extraPaint: Record<string, unknown>,
    {
      bearing = 0,
      pitch = 0,
      view = new MapView({id: 'translate-test'}),
      mode = 'map'
    }: {bearing?: number; pitch?: number; view?: View; mode?: 'map' | 'globe'} = {}
  ) =>
    draw([vectorTile({type, paint: {...paint, ...extraPaint}}, [shape], deviceType, ZOOM, mode)], {
      view,
      viewState: {longitude: 0, latitude: 0, zoom: ZOOM, pitch, bearing}
    }).then(getFootprint);

  describe(`${deviceType}: line, circle and fill-extrusion translate`, () => {
    test.each(CASES)('$name translate moves by its pixels, x right and y down', async c => {
      const {centroid: plain} = await render(c, {});
      expect(Math.abs(plain[0] - CENTER)).toBeLessThanOrEqual(1);
      expect(Math.abs(plain[1] - CENTER)).toBeLessThanOrEqual(1);
      const {centroid} = await render(c, {[`${c.type}-translate`]: [10, 6]});
      expectMoved(centroid, plain, [10, 6]);
    });

    test.each(CASES)(
      '$name translate turns with a map anchor and keeps its screen direction with a viewport anchor',
      async c => {
        // With the map turned 90 degrees, east points up and south to the right on screen.
        const viewOptions = {bearing: 90};
        const {centroid: plain} = await render(c, {}, viewOptions);
        const translate = {[`${c.type}-translate`]: [0, 10]};
        const map = await render(c, translate, viewOptions);
        expectMoved(map.centroid, plain, [10, 0]);
        const viewport = await render(
          c,
          {...translate, [`${c.type}-translate-anchor`]: 'viewport'},
          viewOptions
        );
        expectMoved(viewport.centroid, plain, [0, 10]);
      }
    );

    test.each([
      {
        name: 'a pitched map',
        viewOptions: {pitch: 50},
        offset: [10, 0],
        coordinates: [10 * DEGREES_PER_PIXEL, 0],
        tolerance: 1
      },
      {
        name: 'a globe',
        viewOptions: {
          view: new GlobeView({resolution: 36, id: 'translate-globe'}),
          mode: 'globe' as const
        },
        offset: [0, 10],
        coordinates: [0, -10 * DEGREES_PER_PIXEL],
        tolerance: 1.5
      }
    ])('circle-translate preserves the billboard footprint on $name', async ({
      viewOptions,
      offset,
      coordinates,
      tolerance
    }) => {
      const circle: TranslateCase = {
        type: 'circle',
        feature: POINT,
        paint: {'circle-color': '#000000', 'circle-radius': 8}
      };
      const translated = await render(circle, {'circle-translate': offset}, viewOptions);
      const reference = await render(
        {...circle, feature: feature({type: 'Point', coordinates})},
        {},
        viewOptions
      );
      expectMoved(translated.centroid, reference.centroid, [0, 0], tolerance);
      expect(Math.abs(translated.width - reference.width)).toBeLessThanOrEqual(1);
      expect(Math.abs(translated.height - reference.height)).toBeLessThanOrEqual(1);
    });

    test('circle-translate hides a billboard moved behind the globe', async () => {
      const view = new GlobeView({id: 'translate-globe-limb'});
      const viewState = {longitude: 0, latitude: 0, zoom: -1, minZoom: -1};
      // The elevated point is visible across the limb. Moving it east puts it behind the globe.
      const point = feature({type: 'Point', coordinates: [86, 0, 100_000]});
      const renderCircle = (offset: [number, number]) =>
        draw(
          vectorTile(
            {type: 'circle', paint: {'circle-radius': 8, 'circle-translate': offset}},
            [point],
            deviceType,
            0,
            'globe'
          ),
          {view, viewState}
        );

      getFootprint(await renderCircle([0, 0]));
      const translated = await renderCircle([12, 0]);
      expect(translated.data.every(channel => channel === 255), 'no pixels drawn').toBe(true);
    });
  });
}
