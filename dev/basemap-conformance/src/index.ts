// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

// deck.gl-community
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

// Snapshot of the shared browser harness used by the copied basemap tests.
// Source: deck.gl-community d903803f56f5eccda88a9b4328ab266c98c55fe5.
export type {ConformanceScene, ConformanceRender, ConformanceRenderer, RenderInputs, SavedRender, RendererManifest} from './types';
export {VIEWPORT, STYLES, SCENES, selectScenes} from './scenes';
export {toFixtureUrl, fromFixtureUrl, loadConformanceStyle, createContainer, readCanvas, withTimeout, readFixtureLog, saveRendererManifest, runConformanceScene} from './browser';
export {renderMapLibreScene, createMapLibreRenderer} from './maplibre';
export type {MapLibreDependencies, MapLibreRender, MapLibreScene, MapLibreRenderOptions} from './maplibre';
export {toGray, ssim, detectEdges, edgeScores, normalizeLabel, labelScores, METRICS, METRIC_LABELS, TOLERANCES, getTolerance, computeSceneMetrics, getFloor, getRegressions, tightenBaseline, formatDeltaTable} from './metrics';
export type {GrayImage, EdgeScores, LabelScores, SceneMetrics, MetricName, Baseline} from './metrics';
