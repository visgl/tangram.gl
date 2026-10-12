// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/** Shared control markup for the standalone and website mounts. */
export const terrainMarkup = `
      <div data-example="map"></div>
      <aside data-example="controls">
        <h1 data-example="title">Mercator terrain</h1>
        <p data-example="status" role="status">Loading…</p>
        <p data-example="decoder-status" class="hint"></p>
        <label class="control"><span>Mesh error (meters)</span>
          <select data-example="mesh-error"><option value="5">5 m</option><option value="20" selected>20 m</option><option value="50">50 m</option></select>
        </label>
        <label class="control"><span data-example="detail-label">Tile footprint (CSS pixels)</span>
          <select data-example="tile-detail"><option value="256">256 — finer</option><option value="512" selected>512 — balanced</option><option value="1024">1024 — coarser</option></select>
        </label>
        <label class="control checkbox-control"><input type="checkbox" data-example="wireframe"> Wireframe</label>
        <label class="control checkbox-control"><input type="checkbox" data-example="skirts" checked> Seam skirts</label>
        <label class="control checkbox-control"><input type="checkbox" data-example="follow-terrain"> <span data-example="follow-label">Follow terrain target</span></label>
        <label class="control"><span data-example="clearance-label">Target clearance (physical meters)</span>
          <select data-example="clearance"><option value="20">20 m</option><option value="100">100 m</option><option value="250" selected>250 m</option><option value="500">500 m</option></select>
        </label>
        <button type="button" data-example="retry">Retry failed tiles</button>
        <button type="button" data-example="land-eye" hidden>Lower eye to loaded terrain</button>
        <output data-example="terrain-hit" aria-live="polite">Click the terrain to query elevation</output>
        <p class="hint" data-example="navigation-hint">Drag to pan; Shift-drag to rotate; scroll to zoom. Elevation is not exaggerated.</p>
        <p class="hint" data-example="limitations">Up to nine detail tiles share stitched 2:1 fallback edges and a hard source/decoded-array cache budget (128 MiB by default). Following adjusts the MapView target, not the eye or an avatar; unloaded terrain holds its previous elevation. Picking and following use physical top triangles, never skirts. Tile detail is a local plane estimate, not certified terrain-error LOD. Basemap draping and globe terrain are not implemented here.</p>
        <a href="https://github.com/visgl/tangram.gl/tree/master/examples/terrain" target="_blank" rel="noopener noreferrer">Source</a>
      </aside>
      <div class="canvas-toolbar">
        <div class="canvas-device-tabs" role="tablist" aria-label="Rendering device">
          <button type="button" data-device-type="webgpu" role="tab">WebGPU</button>
          <button type="button" data-device-type="webgl" role="tab">WebGL</button>
        </div>
        <button data-example="fullscreen" class="canvas-fullscreen" type="button" aria-label="Fullscreen">⛶</button>
      </div>
      <p data-example="attribution">Elevation: <a href="https://mapterhorn.com/">Mapterhorn</a> · <a href="https://www.swisstopo.admin.ch/en/height-model-swissalti3d">swissALTI3D / swisstopo</a> · <a href="https://mapterhorn.com/attribution/">all data sources and attribution</a></p>
    `;
