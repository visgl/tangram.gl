// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/** Shared control markup for the standalone and website mounts. */
export const projectedMarkup = `
      <div data-example="map"></div>
      <aside data-example="controls">
        <h1>Projected basemaps</h1>
        <div class="info-tabs" role="tablist" aria-label="Example information">
          <button class="is-active" data-example-tab="controls" role="tab" aria-selected="true">Controls</button>
          <button data-example-tab="about" role="tab" aria-selected="false">About</button>
        </div>
        <section data-example-tab-panel="controls">
        <p data-example="status" role="status">Loading…</p>
        <label class="control"><span>Select projection</span>
          <select data-example="projection"><option value="equal-earth">Equal Earth</option><option value="albers">Albers — North America</option><option value="equirectangular">Equirectangular</option><option value="mercator">Mercator — WGS84 (EPSG:3395)</option><option value="web-mercator">Web Mercator (EPSG:3857)</option></select>
        </label>
        <label class="control"><span>Basemap</span>
          <select data-example="basemap"><option value="raster" selected>NASA Blue Marble</option><option value="vector">OpenFreeMap polygons + roads</option></select>
        </label>
        <label class="control"><span>Loading coverage</span>
          <select data-example="coverage"><option value="world">Whole world</option><option value="regional">North America</option></select>
        </label>
        <button data-example="fit-region" class="projected-fit">Fit loading region</button>
        <label class="control"><span>Loading and detail policy</span><select data-example="detail-mode"><option value="manual">Fixed coverage / manual detail</option><option value="camera">Camera-driven (experimental)</option></select></label>
        <label class="control"><span>Source tile detail</span><select data-example="detail"></select></label>
        <label class="control"><span>Geometry refinement</span><select data-example="refinement"><option value="angular">Fixed angular refinement</option><option value="adaptive">Adaptive — sampled 2 CSS-pixel error</option></select></label>
        <p class="hint">Camera-driven mode restricts loading to the camera inside the selected region for every projection and targets a sampled 256 CSS-pixel tile span within the 256-candidate budget. Adaptive surfaces test edges and triangle interiors with one shared, zoom-bucketed tolerance and vertex budget. Roads use edge tests only. Styling stays at zoom 6.</p>
        <output data-example="coordinates" class="hint">Move over the map to inspect coordinates</output>
        <output data-example="selected-feature" class="hint" aria-live="polite">Click a city marker to select its feature</output>
        </section>
        <section data-example-tab-panel="about" hidden>
      <output data-example="diagnostics" class="hint" aria-live="off">Waiting for projected-worker diagnostics…</output>
          <p class="example-description">A caller-supplied math.gl ProjectionEngine projects coordinates in cooperative chunks and inverts cursor positions. Obsolete hover probes are cancelled; host kernel counts are separate from worker refinement and GPU residency. Tangram workers refine meshes and retain loaded tiles; deck.gl OrthographicView controls the camera. Fit uses sampled geographic bounds, not feature picking or automatic visible-footprint selection.</p>
          <p class="hint">Ground polygons, zoom-stop pixel roads with portable traffic, and selectable city markers. Click a marker to query its feature separately from the ground-coordinate probe. Annotations deliberately do not collide; dense labels may overlap. OpenFreeMap starts at zoom 4 because roads are absent from lower zooms; Blue Marble starts at zoom 2. The example limits coverage to 256 tile candidates per source, 8 concurrent mesh builds and a 32 MB / 256-tile offscreen mesh cache. Each worker also retains at most 16 MB / 32 completed projected meshes. These are not total memory or download limits. Collision-aware labels and terrain picking remain deferred. Blue Marble is overview imagery, not street-level photography.</p>
        </section>
      </aside>
      <nav class="canvas-toolbar" aria-label="Canvas controls"><div class="canvas-device-tabs" role="tablist" aria-label="Rendering device"><button data-device="webgl" role="tab">WebGL 2</button><button data-device="webgpu" role="tab">WebGPU</button></div><button class="canvas-fullscreen" data-example="fullscreen" aria-label="Toggle fullscreen">⛶</button></nav>
      <p data-example="attribution"></p>
    `;
