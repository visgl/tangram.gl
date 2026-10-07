{/*
tangram-layers
SPDX-License-Identifier: MIT
Copyright (c) vis.gl contributors
 */}

# Projection boundary and conventions

Tangram's CPU geographic projection boundary is independent of cameras, deck.gl
views, WebXR room placement, tile formats and shader assembly. The existing
Mercator and globe formulas remain the implementation; this boundary does not
introduce arbitrary CRS support or switch globe rendering to an ellipsoid.

```ts
import {getGeographicProjectionProcedure} from '@vis.gl/tangram-renderer/core';

const projection = getGeographicProjectionProcedure('globe');
const commonPosition = projection.project([-73.98, 40.7, 25]);
const geographicPosition = projection.unproject(commonPosition);
const direction = projection.projectVector([-73.98, 40.7, 25], [1, 0, 0]);
```

The immutable procedure provides `project`, `unproject`, `projectVector`, and
descriptive `type`, `positionUnits`, `latitudeLimit`, and `longitudePolicy`
fields. Existing `projectGeographicPosition`, `projectGeographicVector`, and
`unprojectGlobePosition` exports remain compatible. Geographic lighting now
uses the same procedure boundary. Surface derivatives for LOD continue to use
`getProjectionSurface` internally; there is no new camera or LOD policy.

## Domains and units

Both forward procedures take **[longitude degrees, latitude degrees, altitude
meters]**. Coordinates must be finite and latitude must be within ±90°;
invalid positions retain the existing rejection behavior. Longitudes may be
unwrapped. Input arrays are not mutated, and results are fresh arrays.

| Convention | Web Mercator | Globe |
| --- | --- | --- |
| Absolute position units | EPSG:3857 meters for X/Y; geographic meters for Z | Radius-256 common units |
| Reference radius | 6,378,137 meters for planar projection | 6,370,972 meters for geographic altitude |
| Axes | +X east; +Y north; +Z altitude | Longitude 0°, latitude 0° is -Y; 90° east is +X; north pole is +Z |
| Forward latitude policy | Clamp to ±85.0511287798066° | Retain ±90°, including poles |
| Longitude policy | Preserve world copies; optional finite anchor selects the nearest copy | Periodic; anchor has no effect |
| Inverse longitude | Unwrapped degrees | Canonical `atan2` degrees in [-180, 180] |

The two radius constants are intentionally different. Globe geometry is a
sphere matching deck.gl's GlobeViewport convention, **not** WGS84's oblate
ellipsoid. Its radius at altitude `h` is `256 × (1 + h / 6370972)`.

Mercator inverse accepts finite absolute meter coordinates and preserves
altitude. It does not wrap longitude, reclamp latitude, or undo information
lost by forward polar clamping. Globe inverse rejects a non-finite position or
the sphere center. Unique geographic round trips require altitude greater than
`-6370972` meters; the forward formula historically accepts lower altitudes,
but negative radial scale is not an invertible geographic convention. Longitude
is indeterminate at exact poles, so conformance there checks position, latitude
and altitude rather than assigning a meaningful longitude.

`projectVector` takes an **east/north/up direction**, rotates it into the
projection's axes and preserves length. It does not turn physical meters into
globe common units, apply placement scale, or transform the vector into eye
space. This is the lighting/orientation contract, not a position differential.
Callers must supply finite vectors and valid geographic positions; the vector
helper intentionally adds no new runtime validation.

## Tile and camera coordinates are separate

Math.gl Web Mercator uses a **512-unit world** with north-positive Y. Tangram
converts that world to absolute EPSG:3857 meters. Slippy-map rows instead have
their origin in the north-west and increase southward. `Geo.metersForTile` and
`Geo.tileForMeters` perform that Y-axis conversion; changing a geographic
projection must not silently change tile ownership or rounding.

Tangram's reference tile size is **256 pixels**, and packed tile coordinates
use **4096 units**. Tile-local Y runs negative into the tile after MVT row
coordinates are normalized. These are not the globe's radius-256 units or
math.gl's 512-unit world. The existing tile-boundary arithmetic compatibility
in `web-mercator-math.ts` remains separate from geographic lighting and globe
projection. In particular, raw `Geo` projection has no added polar clamp.

Position projection precedes the host's view/projection matrices. WebXR room
placement supplies another transform; it does not redefine geographic meters.
See [HostFrame](../api-reference/host-frame.md) and
[view integration](./view-integration.md) for frame, visibility and camera ownership.

## Conformance and replacement gate

`projection_conformance.node.spec.ts` uses the published math.gl v5 packages as
independent CPU oracles:

- `@math.gl/web-mercator` forward/inverse results are converted from the
  512-unit world to meters, with Tangram's explicit clamp and world-copy policy.
- A development-only `@math.gl/geospatial` sphere produces ECEF meters.
  `[x, y, z]` maps to Tangram `[y, -x, z] × 256 / 6370972`; inverse tests undo
  that axis change. The test deliberately does not use the WGS84 ellipsoid.
- The corpus covers both poles, the antimeridian, unwrapped worlds, positive
  and negative elevation, invalid inputs, inverse round trips, ENU length and
  LOD surface differentials. Small deterministic cases also retain north-origin
  tile-row and high-zoom ownership checks.

Forward tolerance is 1e-7 meter for Mercator and 1e-10 common unit for globe;
inverse tolerance is 1e-10 degree for Mercator and 1e-7 degree/meter for globe.
These are CPU double-precision tolerances, not shader or image-error bounds.
Existing GlobeViewport and WebGL/WebGPU rendering tests remain separate gates.
The geospatial oracle is not imported by production entries or browser examples.

Future math.gl/projection candidates must adapt to this contract and run against
the same fixtures before a focused production switch. New earth projections
also need their own domain/inverse, geometry refinement, surface differential,
tile visibility, shader and picking contracts. Passing these two existing
projection comparisons is groundwork, not a claim of arbitrary-earth-projection
support.
