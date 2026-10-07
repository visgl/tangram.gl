{/*
tangram-layers
SPDX-License-Identifier: MIT
Copyright (c) vis.gl contributors
 */}

# Experimental projected basemaps

The optional `@vis.gl/tangram-layers/experimental/projected-basemaps` entry renders
flat Tangram polygons and raster meshes in deck.gl's `OrthographicView`. Workers
subdivide the packed tile geometry and project it with math.gl before transferring
the mesh. The ordinary renderer does not bundle the math.gl projection kernels.

Try the [projected basemap example](/examples/deck-projected).
It offers OpenFreeMap vector polygons and NASA GIBS Blue Marble raster imagery.
The raster source uses the documented [GIBS Web Mercator tile service](https://nasa-gibs.github.io/gibs-api-docs/map-library-usage/),
with visible imagery credit; it does not preload the community-funded OSM raster server.

## Usage

```typescript
import {Deck, OrthographicView} from '@deck.gl/core';
import {
  ProjectedBasemapLayer,
  createProjectedBasemapScene
} from '@vis.gl/tangram-layers/experimental/projected-basemaps';

const scene = createProjectedBasemapScene({
  sources: {map: {type: 'MVT', url: '', tilejson: 'https://tiles.openfreemap.org/planet'}},
  layers: {
    water: {data: {source: 'map', layer: 'water'},
      draw: {polygons: {order: 0, color: '#388ab3'}}}
  }
}, {type: 'equal-earth'}, projectionWorkerUrl);

new Deck({
  views: new OrthographicView({flipY: false, controller: true}),
  initialViewState: {target: [0, 0, 0], zoom: -1.5},
  layers: [new ProjectedBasemapLayer({scene, projectedTileZoom: 2})]
});
```

Serve the generated `modules/tangram-renderer/dist/projected-basemaps-worker.js`
as a separate asset and supply its absolute HTTP(S) URL as `projectionWorkerUrl`.
The website build copies this asset automatically. Custom hosting must copy it;
no worker URL is inferred from an application bundle. Display the tile provider's
[required attribution](./tile-providers.md) independently of rendering success.

## Projection and coordinate contract

| `type` | Projection parameters | Initial coverage |
| --- | --- | --- |
| `equal-earth` | Central longitude 0° | One Mercator tile world |
| `equirectangular` | Origin and standard parallel 0° | One Mercator tile world |
| `albers` | Origin −96°, 37.5°; standard parallels 29.5°, 45.5° | North America: −170°, 5° to −40°, 75° |
| `mercator` | Ellipsoidal WGS84 Mercator, EPSG:3395; origin 0°, scale 1 | One Mercator tile world |
| `web-mercator` | Spherical Web Mercator, EPSG:3857; origin 0°, scale 1 | One Mercator tile world |

Equal Earth, Albers, equirectangular and Web Mercator use a 6,378,137 meter sphere.
Mercator uses the WGS84 ellipsoid (major radius 6,378,137 meters, inverse flattening
298.257223563). Mercator and Web Mercator share eastings but have different northings
away from the equator: Web Mercator omits the ellipsoidal latitude correction.
Projected meters are multiplied by
`256 / 6378137` to obtain Cartesian common coordinates; X points east, Y north,
and Z is zero. Unlike a geographic deck view, OrthographicView's zoom measures
pixels per common unit, not tile or styling zoom. Equal Earth, equirectangular and both Mercator variants
are centered on 0°, 0°; Albers is centered on its geographic origin.

`projectedTileZoom` explicitly selects data and style detail, defaults to 2, and
must be in [0, 6]. `projectedVisibleBounds` can reduce geographic loading coverage
but does not follow orthographic panning automatically. The footprint is a finite,
ordered west/south/east/north rectangle in a single world; latitude cannot exceed
±85.0511287798066°. There is no pole completion, wrapped world, or arbitrary cut
meridian in this preview. Albers cannot request coverage outside the region above.
Both Mercator variants retain this tile latitude limit rather than extending to the poles.
Source tiles remain EPSG:3857; `mercator` changes output geometry, not the source grid.

`getProjectedViewFrame(viewport, {projection, visibleBounds, tileZoom})` exposes the
adapter for custom hosts. Its `HostFrame` uses `projection.type: 'projected'` with
an explicit footprint and common-space matrices. It does not label these matrices
as EPSG:3857 meters or use the Mercator/globe surface helpers. The scene's
`scene.cpu_projection` and host projection must agree.

## Supported scenes and resource limits

Use self-contained inline scenes and unlit ground `polygons` or `raster` styles.
The scene helper rejects imports, mixins, shader injection, extrusion, elevation,
interactive feature draws, lines, points and text. Unsupported features fail
explicitly rather than rendering partly in the wrong coordinate system.

The worker keeps original packed positions, UVs, ordering and feature IDs in
addition to Float32 projected positions. Refinement therefore preserves raster
sampling and tile clipping. `maxAngularSpan` defaults to 4° (range 1–30°) and
`maxAdditionalVertices` defaults to 65,536 per mesh (range 0–262,144). Exceeding
the budget rejects a build rather than silently dropping triangles. Tile detail,
geographic footprint and refinement should be kept small for initial applications.

## Next steps

Roads need their own projected stroke/extrusion contract so widths and joins stay
correct under distortion. Labels, picking, lighting, height, camera-dependent LOD,
projection morphing and general seam management are not implemented by this entry.
Existing Mercator, GlobeView and FirstPersonView integrations remain unchanged.
