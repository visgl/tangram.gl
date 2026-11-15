// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/**
 * Holds the vector tile loads of a `BasemapLayer` while its views zoom. In a zoom gesture the
 * tile selection passes through several tile zooms, each shown for a fraction of a second, and
 * each tile loaded at one of them is decoded and triangulated on the main thread. A load that
 * the caller holds waits until no view's zoom has changed for `delay` milliseconds. A pan does not
 * change the zoom, and its loads do not wait.
 */
export class ZoomLoadGate {
  /** Milliseconds a load waits after the last zoom change; 0 loads at once. */
  delay = 0;
  private zooms = new Map<string, number>();
  private lastChange = -Infinity;

  /** Records the zoom of a view at a tile selection. The first zoom of a view is not a change. */
  noteZoom(viewId: string, zoom: number, now = performance.now()): void {
    const last = this.zooms.get(viewId);
    if (last !== zoom) {
      if (last !== undefined) {
        this.lastChange = now;
      }
      this.zooms.set(viewId, zoom);
    }
  }

  /** Milliseconds until a load may start: 0 when no view has zoomed for `delay`. */
  getRemainingDelay(now = performance.now()): number {
    return Math.max(0, this.lastChange + this.delay - now);
  }

  /**
   * Resolves when no view has zoomed for `delay` milliseconds, when `signal` aborts, or when
   * `isHeld` returns false. Returns whether the load was held at all.
   */
  async wait(signal?: AbortSignal | null, isHeld: () => boolean = () => true): Promise<boolean> {
    let held = false;
    for (let remaining = this.getRemainingDelay(); remaining > 0; remaining = this.getRemainingDelay()) {
      if (signal?.aborted || !isHeld()) {
        return held;
      }
      held = true;
      await new Promise<void>(resolve => {
        const timer = setTimeout(done, remaining);
        signal?.addEventListener('abort', done, {once: true});
        function done() {
          clearTimeout(timer);
          signal?.removeEventListener('abort', done);
          resolve();
        }
      });
    }
    return held;
  }
}
