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
Drag on either half to update the shared camera. Controls and VR setup instructions
are available in a collapsible panel below the main viewing area.

The TRON scene uses separate CARTO layers and reads OpenMapTiles `render_height`
and `render_min_height` for building extrusion. It keeps the original animated
traffic shaders on WebGL and the portable traffic implementation on WebGPU.

The globe starts framed to fit the preview and requests at least regional-detail
vector tiles. This reduces the long triangle artifacts from projecting world-level
polygons onto a sphere. Curvature-aware polygon subdivision and polar caps remain
renderer work; Mercator tiles do not cover the poles.
