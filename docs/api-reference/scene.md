{/*
tangram-layers
SPDX-License-Identifier: MIT
Copyright (c) vis.gl contributors
 */}

# Scene API

> Adapted from the original
> [Tangram JavaScript API reference](https://github.com/tangrams/tangram-docs/blob/main/docs/API-Reference/Javascript-API.md)
> under the MIT license, then checked against the `Scene` implementation in
> this repository.

`Scene` owns loaded configuration, sources, tiles, styles, labels, selection,
workers, and render resources. A classic Leaflet layer exposes it as
the example adapter as `layer.scene`; `ClassicWebGLRenderer` exposes it as
`renderer.scene`.

## Creation and lifetime

### `Scene.create(config, options)`

Creates a scene from a URL or configuration object. Host-driven applications
should normally use `ClassicWebGLRenderer.create()` so camera, device, and
render-loop ownership are configured consistently. The classic example shows
how an external adapter can drive a `Scene` from Leaflet.

### `load(config, options)`

Loads a YAML/JSON URL or configuration object. Important options are:

- `base_path`: alternate base URL for scene-relative resources;
- `file_type`: explicitly select a format such as `zip`; and
- `blocking`: control whether the load waits for all dependent work.

Calling `load()` without a new source reloads the current scene.

### `destroy()`

Stops rendering and releases workers, textures, buffers, programs, selection
resources, and the canvas owned by the scene. A host should not use the scene
after destruction.

## Configuration

### `config`

The normalized JavaScript representation of the scene document. It contains
sections such as `sources`, `layers`, `styles`, `textures`, `cameras`, `lights`,
and `scene`.

### `updateConfig(options)`

Re-parses `scene.config`, updates sources, cameras, lights, styles, shaders, and
textures, and optionally rebuilds geometry. Use `rebuild: true` after changing
layers or draw rules that affect generated geometry. Changes to `import` must
be applied through `load()` because imports are resolved before normalization.

### `rebuild(options)`

Rebuilds scene geometry. `sources` may restrict rebuilding to selected data
sources; `new_generation`, `serialize_funcs`, `profile`, and `fade_in` control
advanced rebuild behavior.

### `loadTextures()`

Reloads texture definitions that changed or are backed by live DOM elements.

### `setDataSource(name, config)`

Creates or replaces a source and returns a promise that resolves after it is
loaded. A GeoJSON source may use an in-memory `data` object instead of a URL.

```js
await scene.setDataSource('dynamic-data', {
  type: 'GeoJSON',
  data: featureCollection
});
```

## View and rendering

### `getActiveCamera()` / `setActiveCamera(name)`

Reads or changes the active classic scene camera. Host-driven scenes use
`cameraMode: 'external'`; their matrices come from `HostFrame`, so a scene
camera does not replace the host camera.

### `resizeMap(width, height)`

Updates viewport dimensions and render resources. Host integrations normally
let `ClassicWebGLRenderer.setFrame()` call this from the selected render view.

### `requestRedraw()` / `update(options)`

`requestRedraw()` marks the scene dirty and asks its scheduler for another
frame. `update({force, renderPass})` advances and renders the scene. Applications
using `ClassicWebGLRenderer` should call `renderer.render()` instead.

## Feature inspection

### `getFeatureAt(pixel, options)`

Returns a promise for the top-most interactive feature at `{x, y}`. `radius`
expands the selection area in pixels. The result contains `feature`, `changed`,
and `pixel`; classic Leaflet selection events may also include `leaflet_event`.

Layers must use `interactive: true`, unless introspection is enabled.

### `setIntrospection(enabled)`

Makes all features selectable regardless of individual draw rules. Changing
the value rebuilds the scene.

### `queryFeatures(options)`

Queries features in tiles intersecting the current view and returns a promise.
Supported options include:

- `filter`: a Tangram layer filter, including `$source`;
- `visible`: restrict to rendered or non-rendered features;
- `unique`: deduplicate by all properties, one property, or a property list;
- `group_by`: return groups keyed by one or more properties; and
- `geometry`: include GeoJSON geometry in each result.

Tile queries approximate the visible region: source tiles may extend beyond
the screen and overzoomed tiles can cover a larger area.

```js
const restaurants = await scene.queryFeatures({
  filter: {$layer: 'pois', kind: 'restaurant'},
  visible: true,
  unique: ['name'],
  geometry: true
});
```

## Media capture

### `screenshot({background = 'white'})`

Queues a PNG capture and resolves with `{url, blob, type: 'png'}`. This classic
canvas API is not guaranteed to capture layers drawn by a surrounding deck.gl
application; the host should own composite screenshots.

### `startVideoCapture()` / `stopVideoCapture()`

Uses the browser `MediaRecorder` API when supported. Stopping resolves with a
WebM `{url, blob, type}` object. Host-driven applications should generally
capture their composite canvas instead.

## Events

Use `scene.subscribe({...})` and `scene.unsubscribe({...})`. Public events
retained from the original API include:

- `load`: scene configuration finished loading;
- `error`: unrecoverable scene processing failure;
- `warning`: recoverable source, texture, or configuration issue; and
- `view_complete`: visible geometry is rendered and tile loading is at rest.

```js
const listeners = {
  load: event => console.log('scene loaded', event.config),
  error: event => console.error(event.error || event.message),
  view_complete: () => console.log('view complete')
};

scene.subscribe(listeners);
// Later:
scene.unsubscribe(listeners);
```

`hover` and `click` are Leaflet-layer conveniences configured through the
layer's `events` option or `setSelectionEvents()`; they are not renderer-owned
pointer events.
