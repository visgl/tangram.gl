---
title: Experimental WebXR presentation
---

{/*
tangram-layers
SPDX-License-Identifier: MIT
Copyright (c) vis.gl contributors
 */}

# Experimental WebXR presentation

`@vis.gl/tangram-layers/experimental/webxr` is a tree-shakable, opt-in entry point. Importing the
normal `@vis.gl/tangram-layers` entry does not include WebXR, controller, or placement code.

```ts
import {
  WebXRMapView,
  WebXRPresentation,
  WebXRInputAdapter
} from '@vis.gl/tangram-layers/experimental/webxr';
```

## Presentation model

`WebXRPresentation` owns one logical deck.gl view and view state. It can expand that view into
`mono`, `stereo-preview`, `immersive-vr`, or `auto` render views. Both stereo eyes share the same
deck.gl controller, so mouse, touch, keyboard, and gesture input update one view state.

The presentation returns a matching Tangram `HostFrame` for each frame. Immersive cameras compose
the XR eye matrices and the geospatial placement as:

```text
xrProjection × xrView × placement × projectedPosition
```

The renderer stays independent from deck.gl and WebXR. It only consumes the resulting host frame.

## Placements

- `XRMapPlacement` places a Web Mercator map on a bounded tabletop or unbounded plane. Its scale is
  expressed as geographic meters per physical XR meter.
- `XRGlobePlacement` places a globe with an explicit physical radius and geographic orientation.
- `XRFirstPersonPlacement` maps one XR meter to one geographic meter in a local east-north-up frame.

`createXRPlacementMatrix`, `intersectXRMap`, and `intersectXRGlobe` are exported for applications
that need custom placement or spatial picking.

## Input

`WebXRInputAdapter` translates luma.gl controller snapshots into `XRInteractionIntent` values for
navigation, spatial pointers, selection, grabbing, and application signals. `WebXRPresentation`
accepts those intents without placing WebXR state in `HostFrame`.

The Thor gestures website example is intentionally example-local. It maps webcam and MediaPipe
navigation into the same logical deck.gl controller, but it is not native WebXR hand tracking and
does not add Thor, React, or MediaPipe to the package entry.
