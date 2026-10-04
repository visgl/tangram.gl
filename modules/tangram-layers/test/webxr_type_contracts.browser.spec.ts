// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, expectTypeOf, test} from 'vitest';
import {WebXRPresentation, WebXRMapView, WebXRFirstPersonView, WebXRGlobeView,
    type XRDeckView, type XRPresentationFrame, type XRViewState}
    from '@vis.gl/tangram-layers/experimental/webxr';

test('published view and presentation declarations match their checked implementations', () => {
    expectTypeOf<WebXRMapView>().toExtend<XRDeckView>();
    expectTypeOf<WebXRFirstPersonView>().toExtend<XRDeckView>();
    expectTypeOf<WebXRGlobeView>().toExtend<XRDeckView>();
    const state: XRViewState = {longitude: -74, latitude: 40, position: [0, 0, 200], pitch: 45};
    const presentation = new WebXRPresentation({view: new WebXRFirstPersonView({far: 20000, controller: true}),
        viewState: state, mode: 'stereo-preview'});
    expectTypeOf(presentation.createFrame).returns.toExtend<XRPresentationFrame>();
    const frame = presentation.createFrame({width: 800, height: 600});
    expect(frame.renderViews).toHaveLength(2);
    expect(frame.renderViews.map(view => view.viewport.width)).toEqual([400, 400]);
    expect(presentation.getViewState().position).toEqual([0, 0, 200]);
    presentation.setViewState(current => ({bearing: (current.bearing || 0) + 10}));
    expect(presentation.getViewState().bearing).toBe(10);
    expect(() => presentation.createController()).toThrow('Attach a controller');
    presentation.finalize();
});
