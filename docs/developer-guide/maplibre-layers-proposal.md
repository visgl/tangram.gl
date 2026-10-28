{/*
tangram-layers
SPDX-License-Identifier: MIT
Copyright (c) vis.gl contributors
 */}

# Proposal: MapLibre style layers in tangram.gl

**Status:** proposal, open for discussion. Phase 1 has a runner in this
repository; see [Shared basemap conformance scenes](./visgl-conformance.md#shared-basemap-conformance-scenes).
The other phases are not implemented yet.

This page proposes moving `@deck.gl-community/basemap-layers` from
[visgl/deck.gl-community](https://github.com/visgl/deck.gl-community/tree/master/modules/basemap-layers)
into this repository as a third package, next to `tangram-renderer` and
`tangram-layers`.

## Motivation

There are two vis.gl basemap projects:

- **tangram.gl** is a modernized Mapzen Tangram renderer. It is embedded in
  deck.gl as one `TangramLayer`. Its input is a Tangram scene.
- **`@deck.gl-community/basemap-layers`** interprets MapLibre style JSON. It
  returns ordinary deck.gl sublayers, so deck.gl owns picking, draw order and
  effects.

The two projects do not compete. They read different style formats and have
different strengths:

- **tangram.gl is ahead on:**
  - Rendering power: terrain, curved labels, label fade, cross-tile label
    identity, WebGPU parity and custom shaders.
  - Data formats: PMTiles, MLT and TopoJSON.
  - Quality gates: coverage minimums and render tests on WebGL and WebGPU.
- **basemap-layers is ahead on:**
  - MapLibre style fidelity, SDF glyph PBFs, and Arabic shaping and bidi.
  - MapLibre collision rules and hillshade.
  - A scored reference-render harness against MapLibre GL JS.
  - Safety for untrusted styles: the style cannot run JavaScript.

Applications with existing MapLibre styles benefit from that compatibility path;
Tangram scenes offer their own cartographic and shader capabilities. Both can
support custom cartography. The style language should not require applications
to choose between independent implementations of the underlying map machinery.

One repository for both paths gives one place for basemap work in vis.gl. Tiles,
glyphs, labels and conformance tests then each have one home. This continues the
alignment in [GitHub #49](https://github.com/visgl/tangram.gl/issues/49).

## Architectural direction

The goal is one basemap platform with multiple style frontends over a shared map
core. Repository consolidation helps that work, but does not itself unify the
implementations. Keep three concerns distinct:

- **Style frontends:** Tangram scene loading and evaluation, and MapLibre style
  parsing and expression evaluation. Each retains its documented semantics.
- **Shared map services:** source acquisition, tile residency, projection and
  terrain contracts, geometry preparation, glyph resources, label identity and
  query primitives, where the contracts genuinely overlap.
- **Rendering adapters:** host-independent luma.gl rendering and deck.gl sublayers.
  Sharing map services need not immediately force both paths onto one backend.

Style formats carry more than paint values: MapLibre has specific ordering and
symbol-overlap rules, while Tangram supports functions, animation and shader
blocks. Share mechanisms such as collision indexes without forcing identical
placement policies, and preserve the declarative MapLibre path's trust boundary.
Any common draw/layout contracts must retain those semantics and explicit
extension points, rather than reducing both languages to their common subset.

## Proposal

Add a third package, for example `@vis.gl/tangram-maplibre-layers` in
`modules/maplibre-layers`. The name is open. The package holds the basemap-layers
code. This is an initial home for the MapLibre frontend and its deck.gl adapter,
not a commitment to maintain a second independent map engine permanently.

Keep a MapLibre frontend rather than using translation into existing Tangram
scenes as the compatibility boundary. Such a translation risks losing semantics
such as collision rules, `*-overlap` modes and glyph PBF support. Reuse the existing
MapLibre compatibility code rather than introducing another style interpreter.
Sharing lower-level data, layout and draw contracts is distinct from translating
MapLibre styles into Tangram scenes.

The new package depends on deck.gl, so it goes next to `tangram-layers`.
`tangram-renderer` stays independent of deck.gl, as
[the architecture](./architecture.md) requires.

## Phases

Each phase is a separate pull request, or a separate group of pull requests.
Preserve each frontend's documented behavior and MapLibre compatibility through
the move and extractions. Use shared conformance results to identify unintended
regressions, while keeping intentional Tangram differences explicit.

### 1. Shared conformance scenes

deck.gl-community now has a shared harness in `dev/basemap-conformance`:

- [deck.gl-community #974](https://github.com/visgl/deck.gl-community/pull/974)
  (merged) moved the MapLibre reference renderer and the image metrics there.
- [deck.gl-community #975](https://github.com/visgl/deck.gl-community/pull/975)
  adds shared scenes, recorded fixtures and a scorer. Its first scenes use the
  Streets comparison style from `examples/deck/comparison-style.ts`.

A small pull request here adds a tangram.gl runner for the same scenes. The runner
reads the harness from a pinned deck.gl-community checkout. Both renderers then get
scores on the same inputs.

The scores are a report, not a gate. The comparison style only approximates the
Tangram Streets scene, so a low Tangram score does not show a Tangram defect.

Before cross-repository use, the harness gets two changes from the #975 review:

- Each saved render records a digest of the corpus, the style and the fixtures. The
  scorer checks the digest and the camera before it scores the render.
- The report shows a missing render as missing, so an unsupported scene is not
  confused with an incomplete run.

### 2. Move the package

- Copy `modules/basemap-layers` with its tests and its reference-render harness.
  Keep the git history if the maintainers want it.
- Apply the rules of this repository: license header checks, `*.node.spec` and
  `*.browser.spec` names, no `export *`, ocular-bundle builds, and the pinned
  math.gl version.
- Measure merged Node and browser coverage. Then set the module coverage minimums
  from the measured values.
- Add the module to the WebGL and WebGPU render matrix. Some effects have no WebGPU
  path today: hillshade, halo blur, line blur and extrusion lighting. The WebGPU
  tests record these gaps as known.
- Keep `@deck.gl-community/geo-layers` as a peer dependency at first. The package
  uses its `SharedMVTLayer`, `SharedTileset2D` and `SharedTile2DLayer`.

### 3. Extract shared map services

Start with independently testable mechanisms from basemap-layers:

- The glyph PBF parser and the glyph store.
- Arabic shaping and bidi.
- The collision grid.
- Polylabel.

Define neutral inputs and ownership contracts before moving them. Shared text
services can then let `TangramLayer` use SDF glyphs and Arabic shaping without
replacing its placement policy. Keep the MapLibre style schema and compatibility
rules with its frontend, rather than treating all deck-independent code as core.

Use renderer subpaths for genuinely shared map services where appropriate;
consider math.gl for generic geometry and loaders.gl for decoding utilities.
The existing `tangram-renderer/core` is host-independent, not yet style-neutral.
These extractions can be prepared alongside the package move.

### 4. Merge the parts that overlap

- Converge tile acquisition and residency behind shared contracts, evaluating
  `TangramTileset2D` and `SharedTileset2D` against them. Preserve cancellation,
  resource ownership and style-dependent mesh cache identities. This follows
  batch 7 of
  [the roadmap](./roadmap.md), "Parser and shared tileset production switches".
- Bring cross-tile label identity (`src/map-logic/label-identity.ts`) and label fade
  into the MapLibre layers.

## Publishing

- `@deck.gl-community/basemap-layers` continues to publish from deck.gl-community
  until this repository publishes its packages.
- After that, the deck.gl-community package re-exports the new package and is
  marked deprecated.
- Until then, fixes land in deck.gl-community first and are copied here. New
  features in deck.gl-community stop when phase 2 lands, so only fixes need a copy.

## Open questions

1. A third package, or a subpath of `tangram-layers`?
2. Which package name?
3. Keep the git history of `modules/basemap-layers` (with `git filter-repo`), or
   one import commit with a link to the source?
4. Wait for deck.gl v10 before phase 2? basemap-layers uses `viewport.resolution`
   to find a globe view, and v10 sets it to 0 for all views. We plan to fix this in
   deck.gl-community first.
5. Which services should be shared first, and which frontend policies and
   rendering capabilities must remain explicit at those boundaries?
