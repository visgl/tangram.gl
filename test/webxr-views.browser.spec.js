// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {describe, expect, it} from 'vitest';
import {Timeline} from '@luma.gl/engine';
import {Matrix4} from '@math.gl/core';
import {
  WebXRFirstPersonView,
  WebXRGlobeView,
  WebXRMapView,
  WebXRViewManager
} from '../examples/webxr/webxr-views';

describe('WebXR deck.gl views', () => {
  it.each(['mono', 'stereo-preview'])(
    'routes DOM mouse dragging and double-click through gesture recognition in %s', async (mode) => {
      const element = document.createElement('canvas');
      element.style.cssText = 'position:fixed;left:0;top:0;width:800px;height:300px';
      document.body.appendChild(element);
      const manager = new WebXRViewManager({
        view: new WebXRMapView({id: 'map', controller: {inertia: false}}),
        mode,
        viewState: {longitude: -74, latitude: 40.7, zoom: 14, bearing: 0, pitch: 45}
      });
      const timeline = new Timeline();
      manager.attachController({element, timeline});
      manager.updateController({width: 800, height: 300});
      const initialState = {...manager.getViewState()};
      const pointer = (type, x) => element.dispatchEvent(new PointerEvent(type, {
        bubbles: true, pointerId: 1, pointerType: 'mouse', button: 0,
        buttons: type === 'pointerup' ? 0 : 1, clientX: x, clientY: 150
      }));
      try {
        for (const offset of mode === 'stereo-preview' ? [0, 400] : [0]) {
          manager.setViewState(initialState);
          pointer('pointerdown', 150 + offset);
          pointer('pointermove', 155 + offset);
          pointer('pointermove', 195 + offset);
          pointer('pointerup', 195 + offset);
          expect(manager.getViewState().longitude).not.toBe(initialState.longitude);
          const eyes = manager.makeStereoRenderViews({width: 400, height: 300});
          expect(eyes[0].deckViewport.longitude).toBe(eyes[1].deckViewport.longitude);

          pointer('pointerdown', 150 + offset);
          pointer('pointerup', 150 + offset);
          pointer('pointerdown', 150 + offset);
          pointer('pointerup', 150 + offset);
          // Tap recognition waits for competing double-click-drag gestures to fail.
          await new Promise((resolve) => setTimeout(resolve, 350));
          // Complete the standard controller's double-click zoom transition.
          manager.updateTransitions();
          timeline.setTime(timeline.getTime() + 1000);
          manager.updateTransitions();
          expect(manager.getViewState().zoom).toBeGreaterThan(initialState.zoom);
        }
      } finally {
        manager.finalize();
        element.remove();
      }
    }
  );

  it('routes deck.gl controller updates into the shared stereo view state', () => {
    const element = document.createElement('canvas');
    const manager = new WebXRViewManager({
      view: new WebXRMapView({id: 'map', controller: true}),
      viewState: {longitude: -74, latitude: 40.7, zoom: 14, bearing: 0, pitch: 45}
    });
    const controller = manager.attachController({element, timeline: new Timeline()});
    manager.updateController({width: 400, height: 300});
    const gesture = (type, x) => ({
      type,
      pointerType: 'touch',
      offsetCenter: {x, y: 150},
      deltaX: x - 200,
      deltaY: 0,
      velocity: 0,
      velocityX: 0,
      velocityY: 0,
      srcEvent: {},
      stopPropagation() {}
    });

    controller.handleEvent(gesture('panstart', 200));
    controller.handleEvent(gesture('panmove', 240));
    controller.handleEvent(gesture('panend', 240));

    expect(manager.getViewState().longitude).not.toBe(-74);
    const renderViews = manager.makeStereoRenderViews({width: 200, height: 300});
    expect(renderViews[0].deckViewport.longitude).toBeCloseTo(
      renderViews[1].deckViewport.longitude
    );
    manager.finalize();
  });

  it('subclasses the standard deck.gl views and preserves shared state', () => {
    const manager = new WebXRViewManager({
      view: new WebXRMapView({id: 'map', controller: true}),
      viewState: {longitude: -74, latitude: 40.7, zoom: 14, bearing: 0, pitch: 45}
    });

    const renderViews = manager.makeStereoRenderViews({width: 400, height: 300});

    expect(renderViews.map((view) => view.id)).toEqual(['left-eye', 'right-eye']);
    expect(renderViews[0].deckViewport).not.toBe(renderViews[1].deckViewport);
    expect(renderViews[0].camera.view).not.toEqual(renderViews[1].camera.view);
    expect(renderViews[0].camera.projection).not.toEqual(renderViews[1].camera.projection);
    expect(manager.getViewState().position).toBeUndefined();

    manager.setViewState({longitude: -73.9});
    expect(manager.makeRenderView({id: 'updated', width: 400, height: 300}).deckViewport.longitude).toBe(
      -73.9
    );
  });

  it('creates usable FirstPersonView and GlobeView eye viewports', () => {
    const firstPersonManager = new WebXRViewManager({
      view: new WebXRFirstPersonView({id: 'first-person', far: 20000}),
      viewState: {
        longitude: -74,
        latitude: 40.7,
        position: [0, 0, 200],
        bearing: 0,
        pitch: 45
      }
    });
    const globeManager = new WebXRViewManager({
      view: new WebXRGlobeView({id: 'globe'}),
      viewState: {longitude: -74, latitude: 40.7, zoom: 2}
    });

    expect(firstPersonManager.makeStereoRenderViews({width: 400, height: 300})).toHaveLength(2);
    expect(globeManager.makeStereoRenderViews({width: 400, height: 300})[0].hostFrame.projection).toMatchObject(
      {type: 'globe'}
    );
  });

  it('feeds WebXR eye matrices through the selected view subclass', () => {
    const manager = new WebXRViewManager({
      view: new WebXRMapView({id: 'map'}),
      viewState: {longitude: -74, latitude: 40.7, zoom: 14}
    });
    const identity = new Matrix4();
    const frameState = {
      views: [
        {
          eye: 'left',
          index: 0,
          viewport: [0, 0, 500, 500],
          viewMatrix: identity,
          projectionMatrix: identity
        },
        {
          eye: 'right',
          index: 1,
          viewport: [500, 0, 500, 500],
          viewMatrix: identity,
          projectionMatrix: identity
        }
      ]
    };

    const renderViews = manager.makeXRRenderViews({
      frameState,
      placementMatrix: new Matrix4().translate([1, 2, 3])
    });

    expect(renderViews).toHaveLength(2);
    expect(renderViews[0].viewport).toEqual({x: 0, y: 0, width: 500, height: 500});
    expect(renderViews[1].viewport.x).toBe(500);
    expect(renderViews[0].camera.view[12]).toBe(1);
    expect(renderViews[0].view).toBe(manager.view);
    expect(renderViews[0].viewState).toBe(manager.getViewState());
  });

  it.each([WebXRMapView, WebXRGlobeView, WebXRFirstPersonView])(
    'keeps the anchor at zero disparity with parallel eye cameras for %s', (View) => {
      const manager = new WebXRViewManager({
        view: new View({id: 'stereo', far: 20000}),
        viewState: {longitude: -74, latitude: 40.7, zoom: 2, bearing: 70,
          pitch: 45, position: [0, 0, 200]}
      });
      const eyes = manager.makeStereoRenderViews({width: 400, height: 300});
      const isGlobe = View === WebXRGlobeView;
      const coordinate = isGlobe ? eyes[0].deckViewport.projectPosition([-74, 40.7, 0])
        : [-74 / 180 * 20037508.342789244,
          Math.log(Math.tan((90 + 40.7) * Math.PI / 360)) / Math.PI * 20037508.342789244, 0];
      const projected = eyes.map((eye) => {
        const clip = new Matrix4(eye.camera.projection);
        if (!isGlobe) clip.multiplyRight(eye.camera.view);
        return clip.transformAsPoint(coordinate);
      });
      expect(projected[0][0]).toBeCloseTo(projected[1][0], 5);
      expect(projected[0][1]).toBeCloseTo(projected[1][1], 5);
      expect(Array.from(eyes[0].camera.view).slice(0, 12))
        .toEqual(Array.from(eyes[1].camera.view).slice(0, 12));
      const mono = manager.makeRenderView({id: 'mono', width: 400, height: 300});
      const zeroIPD = manager.makeStereoRenderViews({width: 400, height: 300, interpupillaryDistance: 0});
      expect(Array.from(zeroIPD[0].camera.view)).toEqual(Array.from(mono.camera.view));
    }
  );

  it('uses identical eye-sized controller coordinates on either stereo half', () => {
    const manager = new WebXRViewManager({
      view: new WebXRMapView({id: 'map', controller: true}),
      mode: 'stereo-preview',
      viewState: {longitude: -74, latitude: 40.7, zoom: 14, bearing: 0, pitch: 45}
    });
    manager.attachController({element: document.createElement('canvas'), timeline: new Timeline()});
    manager.updateController({width: 800, height: 300});
    const initialState = {...manager.getViewState()};
    const drag = (controller, offset) => {
      for (const [type, delta] of [['panstart', 0], ['panmove', 40], ['panend', 40]]) {
        controller.handleEvent({type, pointerType: 'touch',
          offsetCenter: {x: 200 + offset + delta, y: 150}, deltaX: delta, deltaY: 0,
          velocity: 0, velocityX: 0, velocityY: 0, srcEvent: {}, stopPropagation() {}});
      }
      return {...manager.getViewState()};
    };
    const leftResult = drag(manager.controller, 0);
    manager.setViewState(initialState);
    const rightResult = drag(manager.rightController, 400);
    expect(leftResult.longitude).not.toBe(initialState.longitude);
    expect(rightResult.longitude).toBeCloseTo(leftResult.longitude, 8);
    expect(rightResult.latitude).toBeCloseTo(leftResult.latitude, 8);
    const rightController = manager.rightController;
    manager.setMode('mono');
    expect(manager.rightController).toBeNull();
    expect(manager.controller).not.toBe(rightController);
    manager.finalize();
  });

  it('keeps keyboard handling on one controller and honors per-frame presentation mode', () => {
    const manager = new WebXRViewManager({
      view: new WebXRMapView({id: 'map', controller: {keyboard: true}}),
      mode: 'mono',
      viewState: {longitude: -74, latitude: 40.7, zoom: 14, bearing: 0, pitch: 45}
    });
    manager.attachController({element: document.createElement('canvas'), timeline: new Timeline()});
    manager.createFrame({width: 800, height: 400, mode: 'stereo-preview'});
    expect(manager.controllerMode).toBe('stereo-preview');
    expect(manager.controller.props.width).toBe(400);
    expect(manager.rightController.props.width).toBe(400);
    expect(manager.rightController.keyboard).toBe(false);
    manager.createFrame({width: 800, height: 400, mode: 'mono'});
    expect(manager.rightController).toBeNull();
    expect(manager.controllerMode).toBe('mono');
    expect(manager.controller.props.width).toBe(800);
    manager.finalize();
  });

  it('moves the eyes oppositely without rotating either camera when separation increases', () => {
    const manager = new WebXRViewManager({
      view: new WebXRMapView({id: 'map'}),
      viewState: {longitude: -74, latitude: 40.7, zoom: 14.5, bearing: -20, pitch: 45}
    });
    const centered = manager.makeStereoRenderViews({width: 400, height: 500,
      interpupillaryDistance: 0});
    const separated = manager.makeStereoRenderViews({width: 400, height: 500,
      interpupillaryDistance: 0.1});
    const translations = separated.map((eye, index) => {
      expect(Array.from(eye.camera.view).slice(0, 12))
        .toEqual(Array.from(centered[index].camera.view).slice(0, 12));
      return eye.camera.view[12] - centered[index].camera.view[12];
    });
    expect(translations[0]).toBeGreaterThan(0);
    expect(translations[1]).toBeLessThan(0);
    expect(translations[0]).toBeCloseTo(-translations[1], 9);
    manager.finalize();
  });
});
