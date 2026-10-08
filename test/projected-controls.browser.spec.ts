// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test, vi} from 'vitest';

const fixtures = vi.hoisted(() => ({
  properties: {} as Record<string, unknown>,
  viewport: {width: 800, height: 600},
  finalize: vi.fn(), dispose: vi.fn(),
  fit: vi.fn(async () => ({target: [50, 60, 0], zoom: -1})),
  probe: vi.fn(async () => [-75, 40]),
  coverage: vi.fn(async (_viewport: unknown, _type: string, bounds: readonly [number, number, number, number]):
    Promise<{bounds: readonly [number, number, number, number] | null; domainFallback: boolean}> => ({bounds, domainFallback: false})),
  transition: vi.fn(async (state: unknown) => ({viewState: state, focus: [-75, 40], clamped: false, domainFallback: false})),
  detail: vi.fn(async () => ({tileZoom: 2, candidateCount: 16, estimatedTilePixels: 200,
    budgetLimited: false, detailLimited: false}))
}));
vi.mock('@deck.gl/core', () => ({
  Deck: class {
    constructor(properties: Record<string, unknown>) {fixtures.properties = properties;}
    setProps(properties: Record<string, unknown>) {Object.assign(fixtures.properties, properties);}
    getViewports() {return [fixtures.viewport];}
    finalize = fixtures.finalize;
  },
  OrthographicView: class {}
}));
vi.mock('@luma.gl/webgpu', () => ({webgpuAdapter: {}}));
vi.mock('@vis.gl/tangram-layers/experimental/projected-basemaps', () => ({
  ProjectedBasemapLayer: class {constructor(readonly props: Record<string, unknown>) {}},
  createProjectedBasemapScene: (scene: unknown) => scene,
  ProjectedBasemapNavigation: class {
    fitBounds = fixtures.fit; unprojectScreenPosition = fixtures.probe;
    getCameraCoverage = fixtures.coverage; reprojectViewState = fixtures.transition; dispose = fixtures.dispose;
  },
  selectProjectedTileDetail: fixtures.detail
}));
vi.mock('@vis.gl/tangram-renderer/core', () => ({countProjectedTileCoordinates: (_bounds: unknown, zoom: number) => 4 ** zoom}));
vi.mock('../examples/projected/projection-engine.js', () => ({createProjectedExampleProjectionEngine: () => ({})}));
vi.mock('../examples/classic/app/attribution.js', async importOriginal => ({
  ...await importOriginal<typeof import('../examples/classic/app/attribution.js')>(),
  getConfiguredAttributions: () => [], updateAttribution: vi.fn()
}));

test('example controls coalesce navigation, discard stale results and release resources on teardown', async () => {
  // Real markup/event handlers; GPU/projection correctness is covered separately, without public-network access here.
  const markup = await (await fetch('/examples/projected/index.html')).text();
  const body = new DOMParser().parseFromString(markup, 'text/html').body;
  const root = document.createElement('div');
  root.innerHTML = body.innerHTML;
  document.body.append(root);
  vi.useFakeTimers();
  const getElement = (selector: string) => {
    const element = root.querySelector(selector);
    if (!(element instanceof HTMLElement)) throw new Error(`Missing control ${selector}`);
    return element;
  };
  const change = (selector: string, value: string) => {
    const element = getElement(selector);
    if (!(element instanceof HTMLSelectElement)) throw new Error('Expected a selector');
    element.value = value;
    element.dispatchEvent(new Event('change'));
  };
  const invoke = (key: string, ...parameters: unknown[]) => {
    const callback = fixtures.properties[key];
    if (typeof callback !== 'function') throw new Error(`Missing Deck callback ${key}`);
    Reflect.apply(callback, null, parameters);
  };
  try {
    await import('../examples/projected/app.js');
    change('#detail-mode', 'manual');
    expect(fixtures.detail).not.toHaveBeenCalled();
    expect(fixtures.coverage).not.toHaveBeenCalled();
    getElement('#fit-region').click();
    await vi.advanceTimersByTimeAsync(0);
    expect(fixtures.properties.viewState).toEqual({target: [50, 60, 0], zoom: -1});
    getElement('#projected-map').dispatchEvent(new PointerEvent('pointermove', {clientX: 100, clientY: 100}));
    await vi.advanceTimersByTimeAsync(0);
    expect(getElement('#coordinates').textContent).toBe('-75.0000°, 40.0000°');
    getElement('#projected-map').dispatchEvent(new PointerEvent('pointerleave'));
    expect(getElement('#coordinates').textContent).toContain('Move over');
    change('#refinement', 'adaptive');
    await vi.advanceTimersByTimeAsync(0);
    invoke('onViewStateChange', {viewState: {target: [0, 0, 0], zoom: 1.2}});
    await vi.advanceTimersByTimeAsync(120);
    const layers = fixtures.properties.layers;
    if (!Array.isArray(layers)) throw new Error('Missing projected layers');
    expect(layers[0].props.projectedProjection.maxProjectedError).toBe(0.5);
    expect(fixtures.detail).not.toHaveBeenCalled();
    expect(fixtures.properties._animate).toBe(true);
    change('#refinement', 'angular');
    await vi.advanceTimersByTimeAsync(0);
    change('#detail-mode', 'camera');
    invoke('onViewStateChange', {viewState: {target: [0, 0, 0], zoom: 1}});
    invoke('onViewStateChange', {viewState: {target: [0, 0, 0], zoom: 2}});
    await vi.advanceTimersByTimeAsync(120);
    expect(fixtures.detail).toHaveBeenCalledTimes(1);
    expect(fixtures.properties.viewState).toEqual({target: [0, 0, 0], zoom: 2});
    expect(getElement('#detail')).toHaveProperty('disabled', true);
    expect(getElement('#status').textContent).toContain('Camera detail 2');
    let finish = (_result: Awaited<ReturnType<typeof fixtures.detail>>) => {};
    fixtures.detail.mockImplementationOnce(() => new Promise(resolve => {finish = resolve;}));
    invoke('onResize');
    await vi.advanceTimersByTimeAsync(120);
    change('#projection', 'albers');
    finish({tileZoom: 4, candidateCount: 256, estimatedTilePixels: 300, budgetLimited: true, detailLimited: false});
    await vi.advanceTimersByTimeAsync(0);
    expect(getElement('#detail')).toHaveProperty('value', '2');
    expect(getElement('#status').textContent).not.toContain('Camera detail 4');
    let rejectFit = (_error: Error) => {};
    fixtures.fit.mockImplementationOnce(() => new Promise((_resolve, reject) => {rejectFit = reject;}));
    getElement('#fit-region').click();
    change('#projection', 'equal-earth');
    rejectFit(new Error('obsolete fit failure'));
    await vi.advanceTimersByTimeAsync(0);
    expect(getElement('#status').textContent).not.toContain('obsolete fit failure');
    let finishTransition = (_result: Awaited<ReturnType<typeof fixtures.transition>>) => {};
    fixtures.transition.mockImplementationOnce(() => new Promise(resolve => {finishTransition = resolve;}));
    change('#projection', 'web-mercator');
    const coverageCalls = fixtures.coverage.mock.calls.length;
    invoke('onViewStateChange', {viewState: {target: [25, 30, 0], zoom: 3}});
    // The old race only occurred when the camera timer finished before the async transition.
    await vi.advanceTimersByTimeAsync(120);
    expect(fixtures.coverage).toHaveBeenCalledTimes(coverageCalls);
    expect(getElement('#projection')).toHaveProperty('value', 'web-mercator');
    // An independent configuration update must not reset or cancel the requested projection either.
    change('#coverage', 'world');
    expect(getElement('#projection')).toHaveProperty('value', 'web-mercator');
    finishTransition({viewState: {target: [999, 999, 0], zoom: 9}, focus: [-75, 40], clamped: false, domainFallback: false});
    await vi.advanceTimersByTimeAsync(0);
    expect(fixtures.properties.viewState).toEqual({target: [25, 30, 0], zoom: 3});
    expect(getElement('#projection')).toHaveProperty('value', 'web-mercator');
    fixtures.transition.mockRejectedValueOnce(new Error('unavailable projection descriptor'));
    change('#projection', 'mercator');
    await vi.advanceTimersByTimeAsync(0);
    expect(getElement('#projection')).toHaveProperty('value', 'web-mercator');
    expect(getElement('#status').textContent).toContain('unavailable projection descriptor');
    const layerScene = () => {
      const layers = fixtures.properties.layers;
      if (!Array.isArray(layers)) throw new Error('Missing example layer');
      return Reflect.get(layers[0], 'props');
    };
    const preparedScene = layerScene().scene;
    fixtures.coverage.mockResolvedValue({bounds: null, domainFallback: false});
    invoke('onResize');
    await vi.advanceTimersByTimeAsync(120);
    expect(layerScene().visible).toBe(false);
    expect(layerScene().scene).toBe(preparedScene);
    expect(getElement('#status').textContent).toContain('outside the loading region');
    fixtures.coverage.mockResolvedValue({bounds: [-120, 20, -80, 50], domainFallback: false});
    invoke('onViewStateChange', {viewState: {target: [0, 0, 0], zoom: 2}});
    await vi.advanceTimersByTimeAsync(120);
    expect(layerScene().visible).toBe(true);
    expect(layerScene().projectedVisibleBounds).toEqual([-120, 20, -80, 50]);
    expect(layerScene().scene).toBe(preparedScene);
    const detailCalls = fixtures.detail.mock.calls.length;
    window.dispatchEvent(new PageTransitionEvent('pagehide'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(fixtures.detail).toHaveBeenCalledTimes(detailCalls);
    expect(fixtures.dispose).toHaveBeenCalledOnce();
    expect(fixtures.finalize).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
    root.remove();
  }
});
