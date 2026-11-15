// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {beforeAll, describe, expect, test} from 'vitest';
import {
  _CustomProjectionViewport as CustomProjectionViewport,
  _GlobeViewport as GlobeViewport,
  WebMercatorViewport
} from '@deck.gl/core';
import {projectionEngine} from '@math.gl/geospatial/projection';
import {getBackgroundSquare} from '../src/projected-background-layer';
import {createMercatorTileMesh, getNormalizedBounds} from '../src/projected-bitmap-layer';
import {getTileFeaturesInLngLat, MAX_ADDED_VERTICES} from '../src/projected-tile-data';
import {
  getMercatorZoom,
  getProjectedPlaneAngle,
  getStyleZoom,
  isGeographicViewport,
  isPositionDrawn,
  isProjectedViewport,
  lngLatToMercatorWorld,
  mercatorWorldToLngLat
} from '../src/projected-viewport';
import {
  CONUS_ALBERS_PROJ,
  projectConusAlbers,
  projectUtm32N
} from '../../../test/projection-reference';

type CRS = ConstructorParameters<typeof CustomProjectionViewport>[0]['crs'];

let utm: CRS;
let albers: CRS;
let polar: CRS;

beforeAll(async () => {
  utm = await projectionEngine.getCRS('EPSG:32632');
  albers = await projectionEngine.getCRS(CONUS_ALBERS_PROJ);
  polar = await projectionEngine.getCRS(
    '+proj=stere +lat_0=-90 +lat_ts=-71 +lon_0=0 +k=1 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs'
  );
});

const createViewport = (crs: CRS, center: number[], zoom: number) =>
  new CustomProjectionViewport({crs, center: [center[0], center[1], 0], zoom, width: 800, height: 600});

describe('projected viewport helpers', () => {
  test('tell a projected view from a map and a globe', () => {
    const projected = createViewport(utm, [9, 48], 10);
    const map = new WebMercatorViewport({longitude: 9, latitude: 48, zoom: 10, width: 800, height: 600});
    const globe = new GlobeViewport({longitude: 9, latitude: 48, zoom: 2, width: 800, height: 600});
    expect([projected, map, globe, null, 3].map(isProjectedViewport)).toEqual([true, false, false, false, false]);
    expect([projected, map, globe, undefined].map(isGeographicViewport)).toEqual([true, false, true, false]);
    // A viewport of another copy of deck.gl has the projection mode, and not the class.
    expect(isProjectedViewport({projectionMode: 3})).toBe(true);
    expect(isProjectedViewport({projectionMode: 1})).toBe(false);
  });

  test('Web Mercator world positions round-trip, and clamp at the pyramid edge', () => {
    for (const lngLat of [[0, 0], [-80, 40], [179.5, -84], [10.5, 48]]) {
      const back = mercatorWorldToLngLat(lngLatToMercatorWorld(lngLat));
      expect(back[0]).toBeCloseTo(lngLat[0], 9);
      expect(back[1]).toBeCloseTo(lngLat[1], 9);
    }
    expect(lngLatToMercatorWorld([-180, 85.051129])[1]).toBeCloseTo(512, 4);
    expect(lngLatToMercatorWorld([180, 89])).toEqual(lngLatToMercatorWorld([180, 85.051129]));
    expect(lngLatToMercatorWorld([0, 0])).toEqual([256, 256]);
  });

  test('the Web Mercator zoom of a projected view falls with the latitude', () => {
    for (const latitude of [1, 30, 48, 60, 75]) {
      const zoom = getMercatorZoom(createViewport(utm, [9, latitude], 12));
      // UTM is conformal with a scale factor of 0.9996 on the central meridian.
      // Web Mercator is not conformal on the ellipsoid: its two axes differ by up to 0.7%.
      const expected = 12 + Math.log2(Math.cos((latitude * Math.PI) / 180)) + Math.log2(0.9996);
      expect(Math.abs(zoom - expected)).toBeLessThan(0.01);
    }
    // Equal-area, not conformal: at latitude 70 the conic projection draws a parallel 1.6 times
    // longer than a meridian, and the zoom is that of their mean, the scale of the ground.
    const north = createViewport(albers, [-96, 70], 8);
    const [x, y] = [400, 300];
    const world = (pixel: number[]) => lngLatToMercatorWorld(north.unproject(pixel));
    const stepX = Math.hypot(...world([x + 16, y]).map((value, axis) => value - world([x, y])[axis]));
    const stepY = Math.hypot(...world([x, y + 16]).map((value, axis) => value - world([x, y])[axis]));
    expect(stepY / stepX).toBeGreaterThan(1.4);
    expect(Math.abs(getMercatorZoom(north) - (8 + Math.log2(Math.cos((70 * Math.PI) / 180))))).toBeLessThan(0.02);
  });

  test('the Web Mercator zoom follows the view zoom where the screen reaches past the pole', () => {
    // A south polar stereographic view centred at latitude -82. Zoomed out, 16 pixels from the
    // center lie past latitude -85.05, the edge of the tile pyramid, and then past the pole.
    const offsets = [];
    for (let zoom = 4; zoom >= -1; zoom -= 0.25) {
      offsets.push(getMercatorZoom(createViewport(polar, [0, -82], zoom)) - zoom);
    }
    // The scale at the view center does not depend on the camera: the offset is the same.
    for (const offset of offsets) {
      expect(Math.abs(offset - offsets[0])).toBeLessThan(0.01);
    }
    // Web Mercator stretches latitude -82 7.2 times, and the projection draws it at scale 0.977.
    expect(offsets[0]).toBeCloseTo(Math.log2(Math.cos((82 * Math.PI) / 180) * 0.977), 1);
    // A center past the edge of the tile pyramid is measured at that edge, where the top row of
    // tiles lies, and not at the zoom of the view.
    const pole = getMercatorZoom(createViewport(polar, [0, -89], 3)) - 3;
    expect(pole).toBeCloseTo(Math.log2(Math.cos((85.05 * Math.PI) / 180) * 0.975), 1);
  });

  test('the style zoom is the Web Mercator zoom in a projected view only', () => {
    const projected = createViewport(utm, [9, 60], 12);
    expect(getStyleZoom(projected)).toBe(getMercatorZoom(projected));
    expect(getStyleZoom(projected)).toBeCloseTo(11, 1);
    expect(getStyleZoom(new WebMercatorViewport({longitude: 9, latitude: 60, zoom: 12, width: 8, height: 8}))).toBe(12);
    expect(getStyleZoom(undefined)).toBe(0);
    expect(getStyleZoom({})).toBe(0);
  });

  test('a view whose center has no longitude/latitude keeps its own zoom', () => {
    const viewport = {
      width: 800,
      height: 600,
      zoom: 7,
      project: () => [Number.NaN, Number.NaN],
      unproject: () => [Number.NaN, Number.NaN]
    };
    expect(getMercatorZoom(viewport)).toBe(7);
    const polar = {...viewport, unproject: () => [0, 89]};
    expect(getMercatorZoom(polar)).toBe(7);
  });

  test('the background square lies around the view, and moves with it', () => {
    const viewport = createViewport(utm, [10.5, 48], 10);
    const square = getBackgroundSquare(viewport)!;
    // Around the view center, in meters of the projection.
    const [x, y] = projectUtm32N([10.5, 48]);
    expect(square.center[0]).toBeCloseTo(x, 2);
    expect(square.center[1]).toBeCloseTo(y, 2);
    // 800 pixels of 76.4 meters, four times, and twice that for a view at half the scale.
    const metersPerPixel = 40075016.6855 / (512 * 2 ** 10);
    expect(square.viewReach).toBeCloseTo(800 * metersPerPixel * 4, 3);
    expect(square.reach).toBeCloseTo(square.viewReach * 2, 6);
    // Kept while the view moves and zooms a little: the layer keeps its polygon.
    expect(getBackgroundSquare(createViewport(utm, [10.6, 48.05], 10.4), square)).toBe(square);
    expect(getBackgroundSquare(createViewport(utm, [10.5, 48], 9.2), square)).toBe(square);
    // Made again when the view leaves it, zooms out past it, or zooms in far.
    const moved = getBackgroundSquare(createViewport(utm, [10.5, 54], 10), square)!;
    expect(moved).not.toBe(square);
    expect(moved.center[1]).toBeGreaterThan(square.center[1] + square.reach * 0.5);
    const zoomedOut = getBackgroundSquare(createViewport(utm, [10.5, 48], 8), square)!;
    expect(zoomedOut.reach).toBeCloseTo(square.reach * 4, 3);
    expect(getBackgroundSquare(createViewport(utm, [10.5, 48], 12), square)!.reach).toBeCloseTo(square.reach / 4, 3);
    // A pitched view shows the ground up to its horizon.
    const pitched = new CustomProjectionViewport({crs: utm, center: [10.5, 48, 0], zoom: 10, width: 800, height: 600, pitch: 60});
    expect(getBackgroundSquare(pitched)!.reach).toBeCloseTo(square.reach * 16, 3);
    // The square covers the screen at every zoom of a view that zooms out.
    let current: ReturnType<typeof getBackgroundSquare> = null;
    for (let zoom = 16; zoom >= -4; zoom -= 0.25) {
      current = getBackgroundSquare(createViewport(utm, [10.5, 48], zoom), current)!;
      const half = (400 * 40075016.6855) / (512 * 2 ** zoom);
      expect(current.reach).toBeGreaterThan(half * 2);
      // Not so large that the screen is a small part of it: the GPU keeps its precision.
      expect(current.reach).toBeLessThan(half * 80);
    }
  });

  test('a view without a finite center keeps the background it has', () => {
    const broken = {width: 800, height: 600, scale: 1, center: [0, 0, 0], unprojectFlat: () => [Number.NaN, Number.NaN]};
    expect(getBackgroundSquare(broken)).toBeNull();
    const square = getBackgroundSquare(createViewport(utm, [10.5, 48], 10))!;
    expect(getBackgroundSquare(broken, square)).toBe(square);
  });

  test('a Web Mercator direction turns by the convergence of the projection', () => {
    for (const {crs, project, at} of [
      {crs: utm, project: projectUtm32N, at: [11.5, 60]},
      {crs: albers, project: projectConusAlbers, at: [-80, 40]},
      {crs: albers, project: projectConusAlbers, at: [-120, 30]}
    ]) {
      const viewport = createViewport(crs, at, 10);
      // East, as the reference projection draws it.
      const from = project(at);
      const to = project([at[0] + 1e-3, at[1]]);
      const east = (Math.atan2(to[1] - from[1], to[0] - from[0]) * 180) / Math.PI;
      expect(Math.abs(east)).toBeGreaterThan(1);
      expect(getProjectedPlaneAngle(viewport, at, 0)).toBeCloseTo(east, 2);
      // North, a quarter turn on in a conformal projection.
      const north = project([at[0], at[1] + 1e-3]);
      const northAngle = (Math.atan2(north[1] - from[1], north[0] - from[0]) * 180) / Math.PI;
      expect(getProjectedPlaneAngle(viewport, at, 90)).toBeCloseTo(northAngle, 2);
      expect(getProjectedPlaneAngle(viewport, at, 180)).toBeCloseTo(east > 0 ? east - 180 : east + 180, 2);
    }
    // A position the view does not project keeps the direction.
    expect(getProjectedPlaneAngle({projectPosition: () => [Number.NaN, 0, 0]}, [0, 0], 30)).toBe(30);
    expect(getProjectedPlaneAngle({projectPosition: () => [1, 1, 0]}, [0, 0], 30)).toBe(30);
    const failing = {projectPosition: () => { throw new Error('assertion failed'); }};
    expect(getProjectedPlaneAngle(failing, [0, 0], 30)).toBe(30);
  });
});

describe('getTileFeaturesInLngLat', () => {
  const features = [
    {type: 'Feature', properties: {name: 'a'}, geometry: {type: 'Point', coordinates: [0.5, 0.5]}},
    {type: 'Feature', properties: {}, geometry: {type: 'LineString', coordinates: [[0, 0], [1, 1, 7]]}},
    {type: 'Feature', properties: {}, geometry: {type: 'GeometryCollection', geometries: [
      {type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]]}
    ]}},
    {type: 'Feature', properties: {}, geometry: null}
  ];

  test('converts tile-local positions to longitude/latitude without changing the tile', () => {
    const snapshot = JSON.stringify(features);
    // Tile 2/2/1 spans longitudes 0 to 90, and latitudes 0 to 66.51 north.
    const converted = getTileFeaturesInLngLat(features, {x: 2, y: 1, z: 2});
    expect(JSON.stringify(features)).toBe(snapshot);
    expect(converted[0].geometry.coordinates[0]).toBeCloseTo(45, 9);
    expect(converted[0].geometry.coordinates[1]).toBeCloseTo(40.979898, 5);
    expect(converted[0].properties).toBe(features[0].properties);
    const line = converted[1].geometry.coordinates;
    const end = line[line.length - 1];
    expect(line[0][0]).toBeCloseTo(0, 9);
    expect(line[0][1]).toBeCloseTo(66.51326, 5);
    expect(end[0]).toBeCloseTo(90, 9);
    expect(end[1]).toBeCloseTo(0, 9);
    // Elevations are kept.
    expect(end[2]).toBe(7);
    expect(converted[2].geometry.geometries[0].coordinates[0][16][0]).toBeCloseTo(90, 9);
    expect(converted[3].geometry).toBeNull();
  });

  test('adds vertices along the long steps of lines and rings', () => {
    const shapes = [
      {type: 'Feature', properties: {}, geometry: {type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]]}},
      {type: 'Feature', properties: {}, geometry: {type: 'LineString', coordinates: [[0.5, 0.5, 10], [0.53, 0.5, 20], [0.53, 1, 40]]}},
      {type: 'Feature', properties: {}, geometry: {type: 'MultiPoint', coordinates: [[0, 0], [1, 1]]}},
      {type: 'Feature', properties: {}, geometry: {type: 'MultiPolygon', coordinates: [[[[0, 0], [0.25, 0], [0, 0.25], [0, 0]]]]}},
      {type: 'Feature', properties: {}, geometry: {type: 'MultiLineString', coordinates: [[[0, 0], [0.5, 0]]]}}
    ];
    const converted = getTileFeaturesInLngLat(shapes, {x: 2, y: 1, z: 2});
    // Each side of the tile, 90 degrees of longitude, in 16 steps.
    const ring = converted[0].geometry.coordinates[0];
    expect(ring).toHaveLength(4 * 16 + 1);
    expect(ring[1][0]).toBeCloseTo(90 / 16, 9);
    expect(ring[1][1]).toBeCloseTo(66.51326, 5);
    // The vertices of an upright side are evenly spaced in Web Mercator space, not in latitude.
    const side = ring.slice(16, 33).map((position: number[]) => lngLatToMercatorWorld(position)[1]);
    for (let index = 1; index < side.length; index++) {
      expect(side[index - 1] - side[index]).toBeCloseTo(128 / 16, 6);
    }
    // A short step is kept, a long one divided, and elevations follow.
    const line = converted[1].geometry.coordinates;
    expect(line).toHaveLength(2 + 8);
    expect(line.map((position: number[]) => position[2])).toEqual([10, 20, 22.5, 25, 27.5, 30, 32.5, 35, 37.5, 40]);
    // Points are positions, not a line.
    expect(converted[2].geometry.coordinates).toHaveLength(2);
    expect(converted[3].geometry.coordinates[0][0]).toHaveLength(4 + 4 + 4 + 1);
    expect(converted[4].geometry.coordinates[0]).toHaveLength(9);
    expect(shapes[0].geometry.coordinates[0]).toHaveLength(5);
  });

  test('a corrupt coordinate far outside the tile adds a bounded count of vertices', () => {
    const line = (coordinates: number[][]) => [
      {type: 'Feature', properties: {}, geometry: {type: 'LineString', coordinates}}
    ];
    const count = (coordinates: number[][]) =>
      getTileFeaturesInLngLat(line(coordinates), {x: 0, y: 0, z: 0})[0].geometry.coordinates.length;
    // Measured inside the tile and its buffer, -1 to 2: 32 parts from 0 to 2, 48 across it.
    expect(count([[0, 0], [1e9, 0]])).toBe(33);
    expect(count([[0, 0], [0, -1e9]])).toBe(17);
    expect(count([[-1e9, 0.5], [1e9, 0.5]])).toBe(49);
    expect(count([[0, 0], [Infinity, 0]])).toBe(33);
    // A coordinate that is not a number adds nothing.
    expect(count([[0, 0], [Number.NaN, 0], [1, 0]])).toBe(3);
    // Both ends are kept as they are.
    const far = getTileFeaturesInLngLat(line([[0, 0], [1e9, 0]]), {x: 0, y: 0, z: 0})[0];
    expect(far.geometry.coordinates).toHaveLength(33);
    expect(far.geometry.coordinates[0][0]).toBeCloseTo(-180, 9);
  });

  test('the vertices added to one tile have a budget, shared by its features', () => {
    // 6000 steps across the tile: 15 vertices each without a budget, 90000 in all.
    const zigzag = Array.from({length: 6001}, (_, index) => [index % 2, index / 6000]);
    const features = [0, 1].map(() => ({
      type: 'Feature',
      properties: {},
      geometry: {type: 'LineString', coordinates: zigzag.slice(0, 3001)}
    }));
    const converted = getTileFeaturesInLngLat(features, {x: 0, y: 0, z: 0});
    const total = converted.reduce((sum, feature) => sum + feature.geometry.coordinates.length, 0);
    expect(total).toBeLessThanOrEqual(2 * 3001 + MAX_ADDED_VERTICES);
    expect(total).toBeGreaterThan(2 * 3001 + MAX_ADDED_VERTICES - 15);
    // Past the budget, steps are left whole: the last vertices are the ones of the source.
    const last = converted[1].geometry.coordinates;
    expect(last[last.length - 2][1]).toBeCloseTo(
      getTileFeaturesInLngLat(
        [{type: 'Feature', properties: {}, geometry: {type: 'Point', coordinates: zigzag[2999]}}],
        {x: 0, y: 0, z: 0}
      )[0].geometry.coordinates[1],
      9
    );
  });

  test('keeps one result per tile', () => {
    const first = getTileFeaturesInLngLat(features, {x: 2, y: 1, z: 2});
    expect(getTileFeaturesInLngLat(features, {x: 2, y: 1, z: 2})).toBe(first);
    expect(getTileFeaturesInLngLat(features, {x: 3, y: 1, z: 2})).not.toBe(first);
    expect(getTileFeaturesInLngLat([...features], {x: 2, y: 1, z: 2})).not.toBe(first);
  });
});

describe('createMercatorTileMesh', () => {
  /** The image position of a longitude/latitude in a tile, in Web Mercator space. */
  const getImagePosition = (bounds: number[], lngLat: number[]) => {
    const [x0, y0] = lngLatToMercatorWorld([bounds[0], bounds[1]]);
    const [x1, y1] = lngLatToMercatorWorld([bounds[2], bounds[3]]);
    const [x, y] = lngLatToMercatorWorld(lngLat);
    return [(x - x0) / (x1 - x0), 1 - (y - y0) / (y1 - y0)];
  };

  test.each([
    {name: 'UTM 32N, zoom 5', bounds: [0, 40.979898, 11.25, 48.922499], project: projectUtm32N},
    {name: 'Conus Albers, zoom 3', bounds: [-90, 0, -45, 40.979898], project: projectConusAlbers},
    {name: 'Conus Albers, zoom 12', bounds: [-80.068359, 39.977120, -79.980469, 40.044438], project: projectConusAlbers}
  ])('$name: each vertex is the projection of its image position, to half a texel', ({bounds, project}) => {
    const mesh = createMercatorTileMesh(bounds, lngLat => [...project(lngLat), 0], 256);
    const vertexCount = mesh.positions.length / 3;
    expect(mesh.projectedPositions).toHaveLength(vertexCount * 3);
    expect(mesh.texCoords).toHaveLength(vertexCount * 2);
    expect(mesh.vertexCount).toBe(mesh.indices.length);
    expect(Math.max(...mesh.indices)).toBe(vertexCount - 1);
    for (let vertex = 0; vertex < vertexCount; vertex++) {
      const lngLat = [mesh.positions[vertex * 3], mesh.positions[vertex * 3 + 1]];
      const [u, v] = getImagePosition(bounds, lngLat);
      expect(mesh.texCoords[vertex * 2]).toBeCloseTo(u, 5);
      expect(mesh.texCoords[vertex * 2 + 1]).toBeCloseTo(v, 5);
      const projected = project(lngLat);
      expect(mesh.projectedPositions[vertex * 3]).toBeCloseTo(projected[0], 4);
      expect(mesh.projectedPositions[vertex * 3 + 1]).toBeCloseTo(projected[1], 4);
    }
    // The corners of the image are the corners of the tile.
    const corners = new Set<string>();
    for (let vertex = 0; vertex < vertexCount; vertex++) {
      const u = mesh.texCoords[vertex * 2];
      const v = mesh.texCoords[vertex * 2 + 1];
      if ((u === 0 || u === 1) && (v === 0 || v === 1)) {
        corners.add(`${u}/${v}`);
        expect(mesh.positions[vertex * 3]).toBeCloseTo(u === 0 ? bounds[0] : bounds[2], 6);
        expect(mesh.positions[vertex * 3 + 1]).toBeCloseTo(v === 0 ? bounds[3] : bounds[1], 6);
      }
    }
    expect(corners.size).toBe(4);

    // Inside each triangle, the mesh lies within a texel of the projection.
    const diagonal = Math.hypot(
      ...project([bounds[2], bounds[3]]).map((value, axis) => value - project([bounds[0], bounds[1]])[axis])
    );
    const texel = diagonal / (256 * Math.SQRT2);
    let worst = 0;
    for (let index = 0; index < mesh.indices.length; index += 3) {
      const [a, b, c] = [0, 1, 2].map(corner => mesh.indices[index + corner]);
      const mix = (values: ArrayLike<number>, size: number, axis: number) =>
        (values[a * size + axis] + values[b * size + axis] + values[c * size + axis]) / 3;
      // The centroid of the triangle in image space, and where the projection puts it.
      const u = mix(mesh.texCoords, 2, 0);
      const v = mix(mesh.texCoords, 2, 1);
      const [x0, y0] = lngLatToMercatorWorld([bounds[0], bounds[1]]);
      const [x1, y1] = lngLatToMercatorWorld([bounds[2], bounds[3]]);
      const exact = project(mercatorWorldToLngLat([x0 + u * (x1 - x0), y0 + (1 - v) * (y1 - y0)]));
      worst = Math.max(
        worst,
        Math.hypot(mix(mesh.projectedPositions, 3, 0) - exact[0], mix(mesh.projectedPositions, 3, 1) - exact[1])
      );
    }
    expect(worst).toBeLessThan(texel);
  });

  test('a tile across the edge of the area of use is drawn inside the area only', () => {
    // math.gl moves positions outside the area of use of UTM zone 32N (6 to 12 degrees east) to
    // its edge. A mesh refined across that edge chases the kink, with no gain on the screen.
    const viewport = createViewport(utm, [9, 47], 6);
    const project = (lngLat: number[]) => viewport.projectPosition(lngLat);
    const bounds = [5.625, 45.089036, 11.25, 48.922499];
    const normalize = (utm as unknown as {converter: {WGS84: {normalize: (p: number[]) => number[]}}})
      .converter.WGS84.normalize;
    const drawn = (tile: number[]) => getNormalizedBounds(tile, normalize);
    expect(drawn(bounds)).toEqual([6, 45.089036, 11.25, 48.922499]);
    const whole = createMercatorTileMesh(bounds, project);
    const clipped = createMercatorTileMesh(bounds, project, undefined, drawn(bounds));
    expect(clipped.indices.length).toBeLessThan(whole.indices.length / 4);
    const vertexCount = clipped.positions.length / 3;
    let west = Infinity;
    for (let vertex = 0; vertex < vertexCount; vertex++) {
      const lngLat = [clipped.positions[vertex * 3], clipped.positions[vertex * 3 + 1]];
      west = Math.min(west, lngLat[0]);
      expect(isPositionDrawn(viewport, lngLat)).toBe(true);
      // The image stays at its place: each vertex samples the image where its position lies.
      const [u, v] = getImagePosition(bounds, lngLat);
      expect(clipped.texCoords[vertex * 2]).toBeCloseTo(u, 5);
      expect(clipped.texCoords[vertex * 2 + 1]).toBeCloseTo(v, 5);
    }
    expect(west).toBeCloseTo(6, 9);
    // A tile outside the area of use has no mesh, and a tile inside it the same mesh as before.
    const outside = [0, 45.089036, 5.625, 48.922499];
    expect(createMercatorTileMesh(outside, project, undefined, drawn(outside)).indices).toHaveLength(0);
    const inside = [8.4375, 47.040182, 9.84375, 48.004625];
    expect(drawn(inside)).toEqual(inside);
    expect(createMercatorTileMesh(inside, project, undefined, drawn(inside))).toEqual(createMercatorTileMesh(inside, project));
    // A normalization that is not a clamp of longitude and latitude does not clip: here it moves
    // the north-east corner only.
    const cutCorner = ([x, y]: number[]) => (x > 10 && y > 48 ? [x, 48, 0] : [x, y, 0]);
    expect(getNormalizedBounds(bounds, cutCorner)).toBeNull();
  });

  test('a large tile takes more triangles than a small one', () => {
    const large = createMercatorTileMesh([-90, 0, -45, 40.979898], lngLat => [...projectConusAlbers(lngLat), 0], 256);
    const small = createMercatorTileMesh([-80.068359, 39.977120, -79.980469, 40.044438],
      lngLat => [...projectConusAlbers(lngLat), 0], 256);
    expect(large.indices.length).toBeGreaterThan(small.indices.length);
    // The seed grid is enough for a tile the projection hardly bends.
    expect(small.indices.length).toBe(4 * 4 * 6);
  });

  test('a projection that cannot be refined draws a fixed grid', () => {
    // No positions at all: every vertex is NaN, and the GPU drops the triangles.
    const missing = createMercatorTileMesh([0, 0, 45, 40.979898], () => [Number.NaN, Number.NaN, 0]);
    expect(missing.indices.length).toBe(16 * 16 * 6);
    expect(missing.positions.every(Number.isFinite)).toBe(true);
    // A projection that throws inside the tile, as outside an area of use.
    const partial = createMercatorTileMesh([0, 0, 45, 40.979898], lngLat => {
      if (lngLat[0] > 30 && lngLat[0] < 44) throw new RangeError('outside the area of use');
      return [...projectUtm32N(lngLat), 0];
    });
    expect(partial.indices.length).toBe(16 * 16 * 6);
  });
});
