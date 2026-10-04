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
logical camera. Each stereo half has a deck.gl controller sized to that half, so mouse,
touch, keyboard, and gesture input update one shared view state.

Desktop stereo uses parallel cameras with off-axis projections and a default 64 mm eye
separation. The geographic anchor is the convergence point. Map and globe placements determine
the physical scale of the eye separation; FirstPersonView uses one geographic meter per XR meter.
Call `updateTransitions()` once per animation frame to advance controller zoom and inertia.
`attachController` registers deck.gl-compatible mouse and touch gesture recognizers, so drag
and double-click input work in both Mono and Stereo Preview.

On desktop, pass CSS pixel dimensions to `createFrame` and `updateController`. Scale the returned
viewport rectangles to drawing-buffer pixels when setting GPU render-pass viewports and scissors.
For immersive frames, pass the full XR framebuffer dimensions matching the native eye rectangles.

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

`new WebXRGlobeView({globeMaxElevation: 9000})` carries a conservative scene
height (geographic meters) through mono, stereo preview and immersive frames.
Omit it when unknown; use `0` only for surface-only content. Room radius and eye
altitude are not this bound. The generated geographic candidate footprints are
still ground-based: elevated-frustum footprint inference remains future work.

`new WebXRFirstPersonView({far: 20000, firstPersonMaxGroundExtent: 20000})`
derives a bounded flat-ground footprint from each actual eye camera, after stereo
offsets or immersive placement have been applied. Extents are local geographic
meters per east/north axis, converted to EPSG:3857 scale at the logical latitude.
Finite near/far planes are required. Horizon-crossing eyes retain ground tiles;
eyes looking entirely into the sky contribute an empty footprint to the union.
This policy does not yet account for terrain or elevated-only visible content.
When the first-person ground anchor is not in front of the eye, stereo preview
uses a convergence plane 100 physical meters forward. Parallel eye cameras stay
unchanged; this avoids collapsing the off-axis convergence distance at the horizon.

Planar placements compensate for Web Mercator's latitude-dependent scale, while altitude remains
in physical meters. Globe placements face their geographic anchor toward the room's positive Z
axis, with north toward positive Y.

`createXRPlacementMatrix`, `intersectXRMap`, and `intersectXRGlobe` are exported for applications
that need custom placement or spatial picking.

## Geographic surface picking

`pickXRSurface` resolves screen pointers or XR room rays against the zero-altitude map plane,
first-person ground plane, or globe sphere. It is CPU-based and works with either rendering
backend. It does **not** select features, intersect terrain/buildings, or account for occlusion.

```ts
import {pickXRSurface} from '@vis.gl/tangram-layers/experimental/webxr';

const frame = presentation.createFrame({width, height});
const hit = pickXRSurface({
  pointer: {x: canvasX, y: canvasY},
  placement: presentation.placement,
  frame
});
if (hit) {
  const [longitude, latitude, altitude] = hit.coordinate; // degrees, degrees, meters (0)
}
```

Use top-origin canvas-relative pixels, matching the dimensions passed to `createFrame`:
CSS pixels for desktop, XR framebuffer pixels for immersive screen pointers. The picker converts
native XR's bottom-origin eye rectangles without modifying the frame. It selects the actual rendered eye from its viewport rectangle,
including off-axis stereo and immersive matrices. An optional `eye: 'left' | 'right'` restricts
that selection. `eye: 'center'` explicitly uses the full-canvas logical desktop viewport for
gaze-style input; it returns `null` in immersive mode rather than inventing a headset camera.
Screen hits outside the viewport or finite camera clipping range return `null`.

Room rays use the same placement snapshot as rendering:

```ts
if (intent.type === 'point' && intent.action === 'select') {
  const hit = pickXRSurface({
    pointer: intent.pointer, // XR reference-space origin and direction
    placement: presentation.placement,
    viewState,
    placementMatrix // supply the actual matrix when room placement is animated
  });
}
```

Omit `placementMatrix` to derive it from the placement and logical view state. Room rays do not
need a frame and are not clipped to an eye camera. A bounded map rejects hits outside its physical
tabletop dimensions; this interaction boundary does not itself clip rendered geometry.

The result contains `coordinate`, `position` (EPSG:3857 meters for planar views, radius-256 common
coordinates for the globe), and `renderViewId` for picks through an actual screen eye. Misses,
parallel/invalid rays, and singular transforms return `null`. Neither the frame nor input arrays
are modified. Keep the frame, view state, and placement matrix from the same rendered snapshot.

The WebXR examples display geographic coordinates on canvas click or XR controller select.
This readout is separate from renderer feature selection and does not intercept navigation.

## Input

`WebXRInputAdapter` translates luma.gl controller snapshots into `XRInteractionIntent` values for
navigation, spatial pointers, selection, grabbing, and application signals. `WebXRPresentation`
accepts those intents without placing WebXR state in `HostFrame`.

### Room-space surface grabbing

`WebXRSurfaceGrabber` is an optional gesture handler separate from navigation and
rendering. A controller squeeze starts a grab at a valid zero-altitude surface hit.
Subsequent hover rays slide a map in its initial room-space plane, or rotate a globe
around its fixed room-space center. Scale, geographic anchor and logical deck view
state are unchanged. First-person ground and screen-pointer grabs are deliberately
unsupported; desktop mono/stereo retains its normal deck.gl controls.

```ts
import {WebXRSurfaceGrabber, createXRPlacementMatrix}
  from '@vis.gl/tangram-layers/experimental/webxr';

const grabber = new WebXRSurfaceGrabber();
// Process one input frame before creating the render frame for either eye.
const viewState = presentation.getViewState();
const placement = presentation.placement;
const context = {placement, viewState,
  placementMatrix: createXRPlacementMatrix(placement, viewState)};
for (const intent of inputAdapter.update(inputStates, elapsedSeconds)) {
  const update = grabber.dispatchInteractionIntent(intent, context);
  if (update) presentation.setPlacement(update);
}
// On session end or application teardown:
grabber.reset();
inputAdapter.reset();
```

The starting context must describe the actual rendered pose, including any room
animation. Freeze that animation when a grab begins (`isGrabbing()`), and render
both eyes from the accepted updated placement. The handler snapshots the baseline
so applying its output does not accumulate translation or rotation feedback.
Only one `inputId` owns a gesture; a second controller cannot steal it. Without IDs,
all pointers share one implicit owner. `WebXRInputAdapter` supplies IDs and activation
`button` values so releasing select does not terminate an independent squeeze grab.
Process all grab intents before navigation: a successful acquisition must suppress
thumbstick movement in that same frame, not just subsequent frames. A missed grab
leaves navigation enabled; release or cancellation restores it. After navigation,
refresh the logical view state and placement matrix before rendering or picking.

Release or cancel ends the gesture without rolling back its last accepted placement.
Disconnects and missing/non-finite controller rays emit cancellation. Tracking
recovery with squeeze still held does not silently reacquire the object. A missed
globe ray or parallel/behind-map ray pauses movement until the pointer returns.
Finite map bounds gate acquisition, not later dragging. Reset both handlers when
ending a session. On a reference-space reset or external view/placement change,
reset the grabber and invalidate the picking snapshot, but retain activation history
until buttons are released (or explicitly suppress held activations). This prevents
an already held squeeze from immediately acquiring content in the new space.

This is ray-driven surface manipulation, not six-degree-of-freedom grip-pose grabbing,
two-handed scaling, terrain/feature picking, or collision-constrained locomotion.
The examples freeze the globe's automatic spin at acquisition and retain the
accepted pose until VR ends; shader animation continues independently.

The Thor gestures website example is intentionally example-local. It maps webcam and MediaPipe
navigation into the same logical deck.gl controller, but it is not native WebXR hand tracking and
does not add Thor, React, or MediaPipe to the package entry.
