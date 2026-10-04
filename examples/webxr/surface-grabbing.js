// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {WebXRSurfaceGrabber} from '@vis.gl/tangram-layers/experimental/webxr';

/** Keep the example's accepted room placement stable after release; reset at session end. */
export function createSurfaceGrabControls() {
  const grabber = new WebXRSurfaceGrabber();
  let placement = null;
  return {
    getPlacement: () => placement,
    isGrabbing: () => grabber.isGrabbing(),
    update(intents, context) {
      for (const intent of intents) {
        const wasGrabbing = grabber.isGrabbing();
        const update = grabber.dispatchInteractionIntent(intent, context);
        if (update) placement = update;
        else if (!wasGrabbing && grabber.isGrabbing()) placement = context.placement;
      }
      return placement;
    },
    reset() {
      grabber.reset();
      placement = null;
    }
  };
}

/** Bind reference-space resets without retaining a listener after the session ends. */
export function bindReferenceSpaceReset(referenceSpace, onReset) {
  referenceSpace?.addEventListener('reset', onReset);
  return () => referenceSpace?.removeEventListener('reset', onReset);
}
