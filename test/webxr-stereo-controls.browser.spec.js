// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {describe, expect, it, vi} from 'vitest';
import {WebXRMapView, WebXRGlobeView, WebXRFirstPersonView, WebXRViewManager}
  from '../examples/webxr/webxr-views';
import {createStereoControls, getPreviewDistance, setPreviewDistance}
  from '../examples/webxr/stereo-controls.js';

const size = {width: 400, height: 500};

/** Create a deterministic preview without network or GPU resources. */
function makePresentation(View) {
  return new WebXRViewManager({
    view: new View({id: 'preview'}),
    viewState: {longitude: -74, latitude: 40.7, zoom: View === WebXRMapView ? 14.5 : 0.8,
      pitch: 0, position: [0, 0, 150]}
  });
}

describe('WebXR physical stereo settings', () => {
  it.each([WebXRMapView, WebXRGlobeView])('sets physical viewing distance with deck zoom for %s', (View) => {
    const presentation = makePresentation(View);
    const original = getPreviewDistance(presentation, size);
    expect(original).toBeGreaterThan(0);
    setPreviewDistance(presentation, size, original * 0.75);
    expect(getPreviewDistance(presentation, size)).toBeCloseTo(original * 0.75, 6);
    const previous = presentation.getViewState().zoom;
    setPreviewDistance(presentation, size, NaN);
    setPreviewDistance(presentation, size, 0);
    expect(presentation.getViewState().zoom).toBe(previous);
    presentation.finalize();
  });

  it.each([WebXRMapView, WebXRGlobeView])('changes room scale without changing geographic view state for %s', (View) => {
    const presentation = makePresentation(View);
    const original = getPreviewDistance(presentation, size);
    const viewState = {...presentation.getViewState()};
    const isGlobe = View === WebXRGlobeView;
    presentation.setPlacement({...presentation.placement,
      ...(isGlobe ? {radius: presentation.placement.radius * 2}
        : {metersPerXRUnit: presentation.placement.metersPerXRUnit / 2})});
    expect(getPreviewDistance(presentation, size)).toBeCloseTo(original * 2, 6);
    expect(presentation.getViewState()).toEqual(viewState);
    presentation.finalize();
  });

  it('updates controls, resets defaults, and removes listeners on teardown', () => {
    const element = document.createElement('details');
    document.body.append(element);
    const presentation = makePresentation(WebXRMapView);
    const original = {...presentation.getViewState()};
    const onChange = vi.fn();
    const controls = createStereoControls({element, presentation, getSize: () => size, onChange});
    const [eyes, scale, distance] = element.querySelectorAll('input');
    try {
      expect(controls.getInterpupillaryDistance()).toBe(0.064);
      eyes.value = '0';
      eyes.dispatchEvent(new Event('input'));
      expect(controls.getInterpupillaryDistance()).toBe(0);
      const frames = presentation.makeStereoRenderViews({...size,
        interpupillaryDistance: controls.getInterpupillaryDistance()});
      expect(frames[0].camera.view).toEqual(frames[1].camera.view);
      expect(frames[0].camera.projection).toEqual(frames[1].camera.projection);
      scale.value = '5000';
      scale.dispatchEvent(new Event('input'));
      expect(presentation.placement.metersPerXRUnit).toBe(5000);
      distance.value = '1';
      distance.dispatchEvent(new Event('input'));
      expect(getPreviewDistance(presentation, size)).toBeCloseTo(1, 6);
      element.querySelector('button').click();
      expect(controls.getInterpupillaryDistance()).toBe(0.064);
      expect(presentation.placement.metersPerXRUnit).toBe(2500);
      expect(presentation.getViewState().zoom).toBe(original.zoom);
      controls.destroy();
      const calls = onChange.mock.calls.length;
      eyes.dispatchEvent(new Event('input'));
      expect(onChange).toHaveBeenCalledTimes(calls);
      expect(element.childElementCount).toBe(0);
    } finally {
      controls.destroy();
      presentation.finalize();
      element.remove();
    }
  });

  it('preserves true first-person scale and hides map-only controls', () => {
    const presentation = makePresentation(WebXRFirstPersonView);
    const original = {...presentation.getViewState()};
    const element = document.createElement('details');
    const controls = createStereoControls({element, presentation, getSize: () => size, onChange() {}});
    setPreviewDistance(presentation, size, 2);
    expect(presentation.getViewState()).toEqual(original);
    const inputs = element.querySelectorAll('input');
    expect(inputs[0].parentElement.hidden).toBe(false);
    expect(inputs[1].parentElement.hidden).toBe(true);
    expect(inputs[2].parentElement.hidden).toBe(true);
    controls.destroy();
    presentation.finalize();
  });
});
