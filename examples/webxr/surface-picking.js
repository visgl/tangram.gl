// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {pickXRSurface} from '@vis.gl/tangram-layers/experimental/webxr';

/**
 * Keep surface-coordinate readout separate from renderer feature selection.
 * @param {{canvas: HTMLCanvasElement, output: HTMLElement | null,
 * getContext: () => Omit<import('@vis.gl/tangram-layers/experimental/webxr').XRSurfacePickingOptions, 'pointer'> | null}} options
 * @returns Desktop/XR selection handler with explicit listener teardown.
 */
export function createSurfacePicker({canvas, output, getContext}) {
  /** Resolve a screen or spatial pointer against the last rendered snapshot. */
  function select(pointer) {
    const context = getContext();
    const hit = context ? pickXRSurface({...context, pointer}) : null;
    if (output) {
      output.textContent = hit
        ? `Basemap surface: ${hit.coordinate[1].toFixed(5)}°, ${hit.coordinate[0].toFixed(5)}° (latitude, longitude).`
        : 'No basemap surface at this pointer.';
    }
    return hit;
  }

  /** Canvas events use CSS pixels; drawing-buffer scale does not change the ray. */
  function onClick(event) {
    if (getContext()?.frame?.mode === 'immersive-vr') return;
    const rectangle = canvas.getBoundingClientRect();
    select({x: event.clientX - rectangle.left, y: event.clientY - rectangle.top});
  }
  canvas.addEventListener('click', onClick);
  return {
    select,
    /** Release the listener without affecting navigation controllers. */
    destroy() {
      canvas.removeEventListener('click', onClick);
    }
  };
}
