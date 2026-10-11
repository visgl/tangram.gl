// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/** Shared control markup for the standalone and website mounts. */
export const terrainMarkup = `
      <div data-example="map"></div>
      <aside data-example="controls">
        <h1>Mercator terrain</h1>
        <p data-example="status" role="status">Loading…</p>
        <label class="control"><span>Mesh error (meters)</span>
          <select data-example="mesh-error"><option value="5">5 m</option><option value="20" selected>20 m</option><option value="50">50 m</option></select>
        </label>
        <label class="control checkbox-control"><input type="checkbox" data-example="wireframe"> Wireframe</label>
        <label class="control checkbox-control"><input type="checkbox" data-example="skirts" checked> Seam skirts</label>
        <button type="button" data-example="retry">Retry failed tiles</button>
        <output data-example="terrain-hit" aria-live="polite">Click the terrain to query elevation</output>
        <p class="hint">Drag to pan; Shift-drag to rotate; scroll to zoom. Elevation is not exaggerated.</p>
        <p class="hint">Experimental streaming: up to nine visible Mapterhorn tiles, coarse parent fallback and warm cache. Local workers decode with loaders.gl; deck.gl renders physical heights. Shared edges and visual skirts reduce seams; skirts never affect elevation queries. Basemap draping and globe terrain are not implemented here.</p>
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
