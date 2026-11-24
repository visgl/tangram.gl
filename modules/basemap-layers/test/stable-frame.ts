// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {Deck} from '@deck.gl/core';

// Browser tests read a frame once the basemap has drawn everything. The deck draws every frame
// itself (`_animate`), after it has updated its layers, and a frame counts only when no layer
// update is pending and every layer is loaded.
//
// A frame drawn with `deck.redraw()` does not update the layers: a tile that has loaded, but whose
// sublayers are not rendered yet, counts as loaded (as in deck.gl's `TileLayer`), and such a frame
// shows the map without it. A wait that draws its next frame only after a loaded frame also draws
// nothing more when no loaded frame comes.

/** Which frames show every layer drawn. */
export type FrameReadyOptions = {
  /** The fewest layers a frame must draw; a basemap draws no sublayers until its style resolves. */
  minLayers?: number;
  /** A further check of the test, made after the layer checks. */
  isReady?: (deck: Deck<any>) => boolean;
  /**
   * Also accepts a frame drawn while a layer update is pending. Only a test of the first frame
   * drawn after a change needs it.
   */
  allowLayerUpdate?: boolean;
};

/**
 * Whether the frame just drawn shows every layer: no layer update is pending, at least
 * `minLayers` layers are drawn, every layer is loaded, and `isReady` passes.
 */
export function isFrameReady(
  deck: Deck<any> | null,
  {minLayers = 1, isReady, allowLayerUpdate = false}: FrameReadyOptions = {}
): boolean {
  const layerManager = (deck as any)?.layerManager;
  if (!deck || !layerManager || (!allowLayerUpdate && layerManager.needsUpdate())) {
    return false;
  }
  const layers = layerManager.getLayers();
  return (
    layers.length >= minLayers &&
    layers.every((layer: any) => layer.isLoaded) &&
    (!isReady || isReady(deck))
  );
}

/**
 * The pixels of the frame just drawn, over `background` when given. Call it in `onAfterRender`,
 * before the drawing buffer is cleared.
 */
export function readFrame(
  deck: Deck<any>,
  width: number,
  height: number = width,
  background?: string
): ImageData {
  const copy = document.createElement('canvas');
  copy.width = width;
  copy.height = height;
  const context = copy.getContext('2d')!;
  if (background) {
    context.fillStyle = background;
    context.fillRect(0, 0, width, height);
  }
  context.drawImage(deck.getCanvas()!, 0, 0);
  return context.getImageData(0, 0, width, height);
}

/** The deck, the frame size and the checks of a `StableFrameWait`. */
export type StableFrameWaitOptions = FrameReadyOptions & {
  /** The deck that draws the frames; it can be created after the wait has started. */
  getDeck: () => Deck<any> | null;
  width: number;
  /** The frame height; the width when not given. */
  height?: number;
  /** A CSS color to draw under the frame when it is read. */
  background?: string;
};

/** When a wait for a stable frame resolves. */
export type StableFrameOptions = {
  /**
   * The number of ready frames in a row to wait for. With `isSame`, the number of ready frames in
   * a row that are the same as the ready frame before them.
   */
  frames: number;
  /** Whether two frames are the same. When not given, every ready frame counts. */
  isSame?: (previous: ImageData, current: ImageData) => boolean;
  /** Milliseconds before the wait fails. When not given, the test timeout bounds the wait. */
  timeout?: number;
  /** Counts no frame until the deck has drawn this many frames in the wait. */
  afterFrames?: number;
  /** A further check of this wait, made after those of the `StableFrameWait`. */
  isReady?: (deck: Deck<any>) => boolean;
  /** As in `FrameReadyOptions`, for this wait. */
  allowLayerUpdate?: boolean;
};

/** Deck props that make the deck draw every frame, and give its frames to the wait. */
export type StableFrameDeckProps = {
  _animate: true;
  onAfterRender: () => void;
};

/** Waits for the frames of one deck. */
export type StableFrameWait = {
  /** Spread these into the props of the deck. */
  deckProps: StableFrameDeckProps;
  /** Resolves with the last frame of `frames` ready (and, with `isSame`, same) frames in a row. */
  waitForStableFrame: (options: StableFrameOptions) => Promise<ImageData>;
  /** Stops the current wait, which then does not settle. */
  cancel: () => void;
  /** Rejects the current wait with `error`, as an `onError` callback of the deck can. */
  fail: (error: unknown) => void;
};

/**
 * Creates a wait for the stable frames of the deck that `getDeck` returns. A ready frame is one
 * that `isFrameReady` accepts; a frame that is not ready starts the count again. One wait runs at
 * a time: a new wait cancels the current one.
 */
export function createStableFrameWait(options: StableFrameWaitOptions): StableFrameWait {
  const {getDeck, width, height = width, background} = options;
  let onFrame: ((deck: Deck<any> | null) => void) | null = null;
  let stop: (() => void) | null = null;
  let rejectWait: ((error: unknown) => void) | null = null;
  // The frames drawn, and when the last one was drawn, for the message of a timeout.
  let drawn = 0;
  let lastDrawn = performance.now();

  const deckProps: StableFrameDeckProps = {
    _animate: true,
    onAfterRender: () => {
      drawn++;
      lastDrawn = performance.now();
      onFrame?.(getDeck());
    }
  };

  const cancel = () => stop?.();

  const fail = (error: unknown) => {
    const reject = rejectWait;
    stop?.();
    reject?.(error);
  };

  /** The state of a wait that timed out. */
  const describe = (count: number): string => {
    const layerManager = (getDeck() as any)?.layerManager;
    const loading = (layerManager?.getLayers() || [])
      .filter((layer: any) => !layer.isLoaded)
      .map((layer: any) => layer.id);
    const update = layerManager?.needsUpdate() || 'none';
    const last = Math.round(performance.now() - lastDrawn);
    return (
      `${count} stable frames, loading [${loading.join(', ')}], layer update ${update}, ` +
      `${drawn} frames drawn, the last ${last} ms ago`
    );
  };

  const waitForStableFrame = (wait: StableFrameOptions) => {
    const {frames, isSame, timeout, afterFrames = 0} = wait;
    const ready: FrameReadyOptions = {
      minLayers: options.minLayers,
      isReady: deck =>
        (!options.isReady || options.isReady(deck)) && (!wait.isReady || wait.isReady(deck)),
      allowLayerUpdate: wait.allowLayerUpdate ?? options.allowLayerUpdate
    };
    cancel();
    return new Promise<ImageData>((resolve, reject) => {
      let previous: ImageData | null = null;
      let count = 0;
      let framesInWait = 0;
      const timer =
        timeout === undefined
          ? undefined
          : window.setTimeout(
              () => fail(new Error(`Timed out rendering: ${describe(count)}`)),
              timeout
            );
      rejectWait = reject;
      stop = () => {
        window.clearTimeout(timer);
        onFrame = null;
        stop = null;
        rejectWait = null;
      };
      onFrame = deck => {
        if (++framesInWait < afterFrames || !isFrameReady(deck, ready)) {
          previous = null;
          count = 0;
          return;
        }
        const image = readFrame(deck!, width, height, background);
        if (isSame) {
          count = previous && isSame(previous, image) ? count + 1 : 0;
        } else {
          count++;
        }
        previous = image;
        if (count >= frames) {
          stop?.();
          resolve(image);
        }
      };
    });
  };

  return {deckProps, waitForStableFrame, cancel, fail};
}
