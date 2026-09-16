// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {Matrix4} from '@math.gl/core';

/** Distance to the geographic anchor along the preview camera's optical axis, in room meters. */
export function getPreviewDistance(presentation, size, viewState = presentation.getViewState()) {
  const viewport = presentation.view.makeViewport({...size, viewState});
  const viewScale = Math.hypot(
    viewport.viewMatrix[0], viewport.viewMatrix[4], viewport.viewMatrix[8]
  );
  const placement = presentation.placement;
  const unitsPerMeter = placement.type === 'globe'
    ? viewScale * 256 / placement.radius
    : viewScale * viewport.distanceScales.unitsPerMeter[2] *
      (placement.type === 'map' ? placement.metersPerXRUnit : 1);
  const anchor = viewport.projectPosition([viewState.longitude, viewState.latitude, 0]);
  return -new Matrix4(viewport.viewMatrix).transformAsPoint(anchor)[2] / unitsPerMeter;
}

/** Dolly via deck.gl zoom so the render, picking and tile-selection cameras stay in agreement. */
export function setPreviewDistance(presentation, size, distance) {
  if (!Number.isFinite(distance) || distance <= 0 || presentation.placement.type === 'first-person') {
    return;
  }
  const viewState = presentation.getViewState();
  // Use the actual viewport transform rather than assuming MapView and GlobeView
  // have identical zoom/altitude conventions. Clamp to ordinary controller zoom limits.
  let minimumZoom = 0;
  let maximumZoom = 20;
  for (let iteration = 0; iteration < 40; iteration++) {
    const zoom = (minimumZoom + maximumZoom) / 2;
    if (getPreviewDistance(presentation, size, {...viewState, zoom}) > distance) {
      minimumZoom = zoom;
    } else {
      maximumZoom = zoom;
    }
  }
  presentation.setViewState({zoom: (minimumZoom + maximumZoom) / 2, transitionDuration: 0});
}

/** Mount example-local physical stereo controls; native XR continues to use headset eye poses. */
export function createStereoControls({element, presentation, getSize, onChange}) {
  let interpupillaryDistance = 0.064;
  const initialPlacement = {...presentation.placement};
  const initialZoom = presentation.getViewState().zoom;
  const isFirstPerson = initialPlacement.type === 'first-person';
  const isGlobe = initialPlacement.type === 'globe';
  const content = document.createElement('div');
  content.className = 'webxr-stereo-controls';
  const listeners = [];
  const listen = (target, event, callback) => {
    target.addEventListener(event, callback);
    listeners.push(() => target.removeEventListener(event, callback));
  };
  const addField = (text, attributes) => {
    const label = document.createElement('label');
    const caption = document.createElement('span');
    caption.textContent = text;
    const input = document.createElement('input');
    Object.assign(input, attributes);
    label.append(caption, input);
    content.append(label);
    return {input, caption};
  };
  const eyeSeparation = addField('Eye separation: 64 mm', {
    type: 'range', min: '0', max: '100', step: '1', value: '64'
  });
  listen(eyeSeparation.input, 'input', () => {
    interpupillaryDistance = eyeSeparation.input.valueAsNumber / 1000;
    eyeSeparation.caption.textContent = `Eye separation: ${eyeSeparation.input.value} mm`;
    onChange();
  });
  const scale = addField(isGlobe ? 'Globe radius (m)' : 'Map scale (m / room m)', {
    type: 'number', min: isGlobe ? '0.05' : '1', max: isGlobe ? '10' : '100000',
    step: 'any', value: String(isFirstPerson ? 1 :
      isGlobe ? initialPlacement.radius : initialPlacement.metersPerXRUnit)
  });
  const distance = addField('Viewing distance (m)', {
    type: 'number', min: '0.05', max: '100000', step: 'any'
  });
  if (isFirstPerson) {
    scale.input.parentElement.hidden = true;
    distance.input.parentElement.hidden = true;
  }
  const refresh = () => {
    if (!isFirstPerson && document.activeElement !== distance.input) {
      const value = getPreviewDistance(presentation, getSize()).toFixed(2);
      if (distance.input.value !== value) distance.input.value = value;
    }
  };
  listen(scale.input, 'input', () => {
    if (!scale.input.value || !scale.input.validity.valid) return;
    presentation.setPlacement({...presentation.placement,
      [isGlobe ? 'radius' : 'metersPerXRUnit']: scale.input.valueAsNumber});
    refresh();
    onChange();
  });
  listen(distance.input, 'input', () => {
    if (!distance.input.value || !distance.input.validity.valid) return;
    setPreviewDistance(presentation, getSize(), distance.input.valueAsNumber);
    onChange();
  });
  listen(distance.input, 'blur', refresh);
  const hint = document.createElement('p');
  hint.className = 'webxr-hint';
  hint.textContent = isFirstPerson
    ? 'First-person stays at 1:1 scale. Move with the standard controls. Eye separation affects Stereo Preview only.'
    : 'Distance follows zoom. Scale also applies in VR; native VR uses headset eye poses. Map scale is geographic meters per room meter.';
  const reset = document.createElement('button');
  reset.type = 'button';
  reset.textContent = 'Reset stereo settings';
  listen(reset, 'click', () => {
    interpupillaryDistance = 0.064;
    eyeSeparation.input.value = '64';
    eyeSeparation.caption.textContent = 'Eye separation: 64 mm';
    presentation.setPlacement({...initialPlacement});
    if (!isFirstPerson) presentation.setViewState({zoom: initialZoom, transitionDuration: 0});
    scale.input.value = String(isFirstPerson ? 1 :
      isGlobe ? initialPlacement.radius : initialPlacement.metersPerXRUnit);
    refresh();
    onChange();
  });
  content.append(hint, reset);
  element.append(content);
  refresh();
  return {
    getInterpupillaryDistance: () => interpupillaryDistance,
    refresh,
    destroy() {
      listeners.forEach((remove) => remove());
      content.remove();
    }
  };
}
