---
sidebar_position: 1
title: Examples
description: Runnable Tangram renderer and deck.gl integration examples.
---

{/*
tangram-layers
SPDX-License-Identifier: MIT
Copyright (c) vis.gl contributors
 */}


Explore the runnable Tangram integrations. Each example is a first-class Docusaurus
page, so the examples sidebar stays visible while you move between demos.

## @vis.gl/tangram-layers

<div className="example-tile-grid">
  <a className="example-tile" href="/tangram.gl/examples/deck">
    <img className="example-tile__image" src="/tangram.gl/img/examples/deck-mapview-perspective.webp" alt="" loading="eager" />
    <span className="example-tile__eyebrow">TangramLayer</span>
    <strong>MapView perspective</strong>
    <span>deck.gl owns the pitched camera and supplies its matrices to the Tangram renderer.</span>
  </a>
  <a className="example-tile" href="/tangram.gl/examples/deck-map-flat">
    <img className="example-tile__image" src="/tangram.gl/img/examples/deck-mapview-flat.webp" alt="" loading="lazy" />
    <span className="example-tile__eyebrow">TangramLayer</span>
    <strong>MapView flat</strong>
    <span>An orthographic Web Mercator view using the same host-driven renderer contract.</span>
  </a>
  <a className="example-tile" href="/tangram.gl/examples/deck-globe">
    <img className="example-tile__image" src="/tangram.gl/img/examples/deck-globe.webp" alt="" loading="lazy" />
    <span className="example-tile__eyebrow">TangramLayer · experimental</span>
    <strong>GlobeView</strong>
    <span>Project Tangram’s vector-tile geometry onto deck.gl’s host-controlled globe.</span>
  </a>
  <a className="example-tile" href="/tangram.gl/examples/deck-first-person">
    <img className="example-tile__image" src="/tangram.gl/img/examples/deck-first-person.webp" alt="" loading="lazy" />
    <span className="example-tile__eyebrow">Capability preview</span>
    <strong>FirstPersonView</strong>
    <span>Explore Tangram from deck.gl’s ground-aware first-person camera.</span>
  </a>
</div>

## @vis.gl/tangram-layers (WebXR)

<div className="example-tile-grid">
  <a className="example-tile" href="/tangram.gl/examples/webxr">
    <img className="example-tile__image" src="/tangram.gl/img/examples/webxr-globe.webp" alt="" loading="lazy" />
    <span className="example-tile__eyebrow">luma.gl experimental · WebXR</span>
    <strong>WebXR GlobeView</strong>
    <span>Render one Tangram scene into host-provided left- and right-eye framebuffers.</span>
  </a>
  <a className="example-tile" href="/tangram.gl/examples/webxr-map-view">
    <img className="example-tile__image" src="/tangram.gl/img/examples/webxr-mapview.webp" alt="" loading="lazy" />
    <span className="example-tile__eyebrow">luma.gl experimental · WebXR</span>
    <strong>WebXR MapView</strong>
    <span>Place a pitched Tangram basemap in physical space with a stereoscopic tabletop view.</span>
  </a>
  <a className="example-tile" href="/tangram.gl/examples/webxr-first-person">
    <img className="example-tile__image" src="/tangram.gl/img/examples/webxr-first-person.webp" alt="" loading="lazy" />
    <span className="example-tile__eyebrow">luma.gl experimental · WebXR</span>
    <strong>WebXR FirstPersonView</strong>
    <span>Stand at street level while Tangram uses per-eye first-person camera matrices.</span>
  </a>
  <a className="example-tile" href="/tangram.gl/examples/webxr-thor">
    <img className="example-tile__image" src="/tangram.gl/img/examples/webxr-thor.webp" alt="" loading="lazy" />
    <span className="example-tile__eyebrow">Desktop gestures · WebXR</span>
    <strong>Thor gestures</strong>
    <span>Drive the shared logical view with webcam gesture intents in mono or stereo preview.</span>
  </a>
</div>

## @vis.gl/tangram-renderer

<div className="example-tile-grid">
  <a className="example-tile" href="/tangram.gl/examples/classic">
    <img className="example-tile__image" src="/tangram.gl/img/examples/renderer-playground.webp" alt="" loading="lazy" />
    <span className="example-tile__eyebrow">Playground</span>
    <strong>Classic playground</strong>
    <span>Edit schema-validated scene JSON and explore the original Tangram styling workflow.</span>
  </a>
  <a className="example-tile" href="/tangram.gl/examples/classic?scene=styles/local-basemap.yaml">
    <img className="example-tile__image" src="/tangram.gl/img/examples/renderer-local-streets.webp" alt="" loading="lazy" />
    <span className="example-tile__eyebrow">Offline vector</span>
    <strong>Local streets</strong>
    <span>A keyless local vector-tile preview for quick renderer experiments.</span>
  </a>
  <a className="example-tile" href="/tangram.gl/examples/classic?scene=styles/local-tron.yaml">
    <img className="example-tile__image" src="/tangram.gl/img/examples/renderer-local-tron.webp" alt="" loading="lazy" />
    <span className="example-tile__eyebrow">Offline vector</span>
    <strong>TRON preview</strong>
    <span>Dark neon roads and animated styling using the local preview data.</span>
  </a>
  <a className="example-tile" href="/tangram.gl/examples/classic?scene=styles/open-light-raster.yaml">
    <img className="example-tile__image" src="/tangram.gl/img/examples/renderer-open-light.webp" alt="" loading="lazy" />
    <span className="example-tile__eyebrow">Raster</span>
    <strong>Open light map</strong>
    <span>A light raster backdrop for comparing scene composition and overlays.</span>
  </a>
  <a className="example-tile" href="/tangram.gl/examples/classic?scene=styles/open-streets-raster.yaml">
    <img className="example-tile__image" src="/tangram.gl/img/examples/renderer-open-streets.webp" alt="" loading="lazy" />
    <span className="example-tile__eyebrow">Raster</span>
    <strong>Open street map</strong>
    <span>A street-map raster alternative for testing the renderer without vector data.</span>
  </a>
  <a className="example-tile" href="/tangram.gl/examples/classic?scene=styles/projection-morph.yaml">
    <img className="example-tile__image" src="/tangram.gl/img/examples/renderer-projection-morph.webp" alt="" loading="lazy" />
    <span className="example-tile__eyebrow">Shader projection</span>
    <strong>Albers projection morph</strong>
    <span>Morph vertices between geographic projections as zoom changes without replacing the host camera.</span>
  </a>
  <a className="example-tile" href="/tangram.gl/examples/classic?scene=styles/simple.yaml">
    <img className="example-tile__image" src="/tangram.gl/img/examples/renderer-simple.webp" alt="" loading="lazy" />
    <span className="example-tile__eyebrow">Style</span>
    <strong>Simple</strong>
    <span>The compact starting point for learning scene sources, layers, and draw rules.</span>
  </a>
  <a className="example-tile" href="/tangram.gl/examples/classic?scene=styles/bubble-wrap.yaml">
    <img className="example-tile__image" src="/tangram.gl/img/examples/renderer-bubble-wrap.webp" alt="" loading="lazy" />
    <span className="example-tile__eyebrow">Style</span>
    <strong>Bubble Wrap</strong>
    <span>A colorful, playful map style with layered geometry and labels.</span>
  </a>
  <a className="example-tile" href="/tangram.gl/examples/classic?scene=styles/walkabout.yaml">
    <img className="example-tile__image" src="/tangram.gl/img/examples/renderer-walkabout.webp" alt="" loading="lazy" />
    <span className="example-tile__eyebrow">Style</span>
    <strong>Walkabout</strong>
    <span>A hand-drawn travel-map treatment for exploring expressive styling.</span>
  </a>
  <a className="example-tile" href="/tangram.gl/examples/classic?scene=styles/refill.yaml">
    <img className="example-tile__image" src="/tangram.gl/img/examples/renderer-refill.webp" alt="" loading="lazy" />
    <span className="example-tile__eyebrow">Style</span>
    <strong>Refill</strong>
    <span>A dense, high-contrast city map with detailed roads and labels.</span>
  </a>
  <a className="example-tile" href="/tangram.gl/examples/classic?scene=styles/refill-blue-terrain.yaml">
    <img className="example-tile__image" src="/tangram.gl/img/examples/renderer-refill-blue-terrain.webp" alt="" loading="lazy" />
    <span className="example-tile__eyebrow">Style</span>
    <strong>Refill Blue Terrain</strong>
    <span>A cool terrain variation of the Refill style.</span>
  </a>
  <a className="example-tile" href="/tangram.gl/examples/classic?scene=styles/tron.yaml">
    <img className="example-tile__image" src="/tangram.gl/img/examples/renderer-tron.webp" alt="" loading="lazy" />
    <span className="example-tile__eyebrow">Style</span>
    <strong>TRON</strong>
    <span>Neon roads, glows, and animated highway traffic from the original style.</span>
  </a>
  <a className="example-tile" href="/tangram.gl/examples/classic?scene=styles/crosshatch-preview.yaml">
    <img className="example-tile__image" src="/tangram.gl/img/examples/renderer-crosshatch-preview.webp" alt="" loading="lazy" />
    <span className="example-tile__eyebrow">Shader</span>
    <strong>Crosshatch preview</strong>
    <span>A local preview of texture and fragment-shader styling.</span>
  </a>
  <a className="example-tile" href="/tangram.gl/examples/classic?scene=styles/crosshatch.yaml">
    <img className="example-tile__image" src="/tangram.gl/img/examples/renderer-crosshatch.webp" alt="" loading="lazy" />
    <span className="example-tile__eyebrow">Shader</span>
    <strong>Crosshatch</strong>
    <span>The bundled texture and shader example from the classic gallery.</span>
  </a>
  <a className="example-tile" href="/tangram.gl/examples/classic?scene=styles/rainbow-buildings.yaml">
    <img className="example-tile__image" src="/tangram.gl/img/examples/renderer-rainbow-buildings.webp" alt="" loading="lazy" />
    <span className="example-tile__eyebrow">Fragment shader</span>
    <strong>Rainbow Buildings</strong>
    <span>Colorful building surfaces driven by a fragment shader.</span>
  </a>
  <a className="example-tile" href="/tangram.gl/examples/classic?scene=styles/popup-buildings.yaml">
    <img className="example-tile__image" src="/tangram.gl/img/examples/renderer-popup-buildings.webp" alt="" loading="lazy" />
    <span className="example-tile__eyebrow">Vertex shader</span>
    <strong>Pop-up Buildings</strong>
    <span>Extruded building animation driven by a vertex shader.</span>
  </a>
  <a className="example-tile" href="/tangram.gl/examples/leaflet">
    <img className="example-tile__image" src="/tangram.gl/img/examples/renderer-leaflet.webp" alt="" loading="lazy" />
    <span className="example-tile__eyebrow">Leaflet</span>
    <strong>Leaflet integration</strong>
    <span>The packaged classic integration preserves Tangram’s historical Leaflet lifecycle.</span>
  </a>
</div>

## Tile loading formats

Compare a regular MVT tile service with MVT tiles stored in a PMTiles archive
and MapLibre Tile (MLT) tiles. The latter two load the optional loaders.gl
worker add-on; all three use public demo data sources.

<div className="example-tile-grid example-tile-grid--compact">
  <a className="example-tile" href="/tangram.gl/examples/classic?scene=styles/loaders-mvt.yaml">
    <span className="example-tile__eyebrow">MVT · TileJSON</span>
    <strong>OpenFreeMap vector tiles</strong>
    <span>A direct MVT baseline from the keyless OpenFreeMap planet tiles.</span>
  </a>
  <a className="example-tile" href="/tangram.gl/examples/classic?scene=styles/loaders-pmtiles.yaml">
    <span className="example-tile__eyebrow">MVT · PMTiles archive</span>
    <strong>Protomaps PMTiles</strong>
    <span>Load raw MVT tile bytes by Z/X/Y from one cloud-hosted archive.</span>
  </a>
  <a className="example-tile" href="/tangram.gl/examples/classic?scene=styles/loaders-mlt.yaml">
    <span className="example-tile__eyebrow">MLT · Tile service</span>
    <strong>MapLibre Tile demo</strong>
    <span>Decode MapLibre's public MLT demo tiles with the optional worker.</span>
  </a>
</div>
