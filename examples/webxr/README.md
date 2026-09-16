<!--
tangram-layers
SPDX-License-Identifier: MIT
Copyright (c) vis.gl contributors
-->

# Tangram WebXR example

This experimental renderer example uses `WebXRManager` and
`WebXRAnimationFrameProvider` from `@luma.gl/experimental`. A single Tangram
scene and tile cache are rendered once per XR view using luma.gl's per-eye
framebuffer, viewport, view matrix and projection matrix. The same renderer can
be explored as a `GlobeView`, physical tabletop `MapView`, or street-level
`FirstPersonView` by passing `?view=globe`, `?view=map`, or
`?view=firstPerson`.

The desktop preview works without an XR device. When no immersive runtime is
available, **Enter VR** renders a side-by-side stereo fallback with distinct
left- and right-eye matrices. A connected headset or the Immersive Web Emulator
exercises the real `immersive-vr` session path. WebGL 2 is the default backend.
Both WebGL 2 and WebGPU support mono and stereo preview; native immersive WebGPU
requires a browser that exposes `XRGPUBinding`.

Each preview eye renders directly into its half of the GPU canvas, sharing one
depth/color target and scene. The second pass preserves the first eye's output.
Parallel off-axis cameras provide stereo depth at the placement's physical scale.
Two-finger trackpad movement pans the map; touch pinch zooms and rotates it
(ctrl-wheel remains zoom). WebGPU submits each eye's render pass before preparing the next eye: Tangram reuses
camera and per-mesh uniform buffers, so deferring both eyes to one final submission
would let the second eye's buffer writes overwrite the first eye's matrices.
This orders GPU work without waiting for completion; WebGL keeps its immediate path.

Open **Stereo settings** to adjust eye separation (default 64 mm), map scale
(geographic meters per room meter), or globe radius. **Viewing distance** is the
optical-axis distance to the geographic anchor in room meters; it changes deck.gl
zoom so rendering, controllers, picking and tile selection use the same camera.
Zooming with the mouse updates that distance readout. Reset restores the original
scale, eye separation and zoom. First-person remains 1:1 and exposes only eye
separation. Native VR always uses the headset's eye poses; the scale control also
applies to immersive map/globe placement, but preview eye separation and distance
do not override headset tracking.
Drag on either half to update the shared camera. Controls and VR setup instructions
are available in a collapsible panel below the main viewing area.

The TRON scene uses separate CARTO layers and reads OpenMapTiles `render_height`
and `render_min_height` for building extrusion. It keeps the original animated
traffic shaders on WebGL and the portable traffic implementation on WebGPU.

The globe starts framed to fit the preview and requests at least regional-detail
vector tiles. This reduces the long triangle artifacts from projecting world-level
polygons onto a sphere. Curvature-aware polygon subdivision and polar caps remain
renderer work; Mercator tiles do not cover the poles.
