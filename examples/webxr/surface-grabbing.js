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
    /**
     * Process the entire grab frame before allowing thumbstick navigation.
     * @param {(intent: import('@vis.gl/tangram-layers/experimental/webxr').XRInteractionIntent) => void} [dispatchNavigation] Apply navigation only when no grab owns this frame.
     */
    update(intents, context, dispatchNavigation) {
      for (const intent of intents) {
        const wasGrabbing = grabber.isGrabbing();
        const update = grabber.dispatchInteractionIntent(intent, context);
        if (update) placement = update;
        else if (!wasGrabbing && grabber.isGrabbing()) placement = context.placement;
      }
      if (!grabber.isGrabbing() && dispatchNavigation) {
        for (const intent of intents) {
          if (intent.type === 'navigate') dispatchNavigation(intent);
        }
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
