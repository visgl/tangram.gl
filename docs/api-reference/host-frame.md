{/*
tangram-layers
SPDX-License-Identifier: MIT
Copyright (c) vis.gl contributors
 */}

# HostFrame API

`HostFrame` is the host-to-renderer boundary for viewport, geographic, and
camera state. It has no deck.gl dependency.

```js
import {HostFrame} from '@vis.gl/tangram-renderer';
```

## Constructor

```js
new HostFrame({
  viewport,
  geographicAnchor,
  projection,
  renderViews,
  activeRenderViewId,
  tileBuffer
});
```

### `viewport`

The complete render target as `{width, height}`. Normalized frames also expose
`x` and `y`, which default to zero.

### `geographicAnchor`

Shared state `{longitude, latitude, altitude, zoom}`. `altitude` defaults to
zero. The current Web Mercator visibility implementation uses `zoom` for tile
selection and style evaluation.

### `projection`

The deck-independent geographic projection contract. It defaults to
`{type: 'web-mercator'}` for backward compatibility and also recognizes
`{type: 'globe', visibleBounds: [west, south, east, north]}` so host adapters
can describe spherical frames without importing deck.gl classes into the
renderer package.

The experimental globe path converts Web Mercator tile vertices to deck's
radius-256 sphere and uses `visibleBounds` for tile selection. Horizon-aware
culling, adaptive tessellation, label orientation, and picking refinements are
tracked in [GlobeView support](https://github.com/visgl/tangram.gl/issues/48).

### `renderViews`

A non-empty array of named render views:

```js
{
  id: 'main',
  viewport: {x: 0, y: 0, width, height},
  camera: {
    view: viewMatrix,
    projection: projectionMatrix,
    position: [x, y, z]
  }
}
```

Each matrix must contain 16 values. Render-view IDs must be unique. A missing
first ID becomes `default`; later missing IDs become `view-1`, `view-2`, and so
on.

### `activeRenderViewId`

The view selected when `renderViewId` is not supplied to the renderer. It
defaults to the first render view.

### `tileBuffer`

A finite non-negative number of additional Web Mercator tiles to retain around
the current bounds. It defaults to zero. Globe adapters normally provide zero
because their geographic visibility bounds already cover the host viewport.

## Static methods

### `HostFrame.from(frame)`

Returns an existing `HostFrame`, constructs one from the current shape, or
normalizes the legacy shape:

```js
HostFrame.from({
  viewport: {width, height},
  view: {longitude, latitude, zoom},
  projection: {type: 'web-mercator'},
  camera,
  tileBuffer
});
```

### `HostFrame.fromLegacy(frame)`

Explicitly converts the legacy shape into a frame with one `default` render
view.

## Instance methods

### `getRenderView(renderViewId)`

Returns a normalized render view. Omitting the ID returns the active render
view. An unknown ID throws an error before any renderer state is changed.

## Stereo-ready ownership

The frame stores shared geographic and tile state once while allowing separate
left/right cameras and viewport rectangles. A stereo host selects each view
when submitting its render pass:

```js
renderer.render({frame, renderViewId: 'left-eye', renderPass: leftPass});
renderer.render({renderViewId: 'right-eye', renderPass: rightPass});
```

This contract does not yet orchestrate WebXR frames or compute the union of
arbitrary view frusta. A stereoscopic pair should share its geographic anchor,
LOD zoom, and visible tile set.
