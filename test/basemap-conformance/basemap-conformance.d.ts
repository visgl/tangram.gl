// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/**
 * The part of the shared harness's browser entry (deck.gl-community
 * `dev/basemap-conformance/src/index.ts`) that the runner uses. The harness is not a package: it
 * is read from a pinned checkout that `vitest.conformance.config.ts` aliases as
 * `basemap-conformance`, so `yarn typecheck` works without the checkout. Keep these declarations in
 * step with `src/types.ts` of the pinned commit.
 */
declare module 'basemap-conformance' {
  export type ConformanceScene = {
    id: string;
    style: string;
    center: [number, number];
    zoom: number;
    pitch?: number;
    bearing?: number;
    note?: string;
  };
  export type ConformanceRender = {
    pixels: Uint8ClampedArray;
    width: number;
    height: number;
    labels: string[] | null;
    labelNote?: string;
    problems: string[];
    meta?: Record<string, unknown>;
  };
  export type ConformanceRenderer = {
    id: string;
    name: string;
    supports(scene: ConformanceScene): boolean;
    render(scene: ConformanceScene, style: any): Promise<ConformanceRender>;
  };
  /** What `runConformanceScene` saves next to each render. The harness owns its format. */
  export type SavedRender = {
    renderer: string;
    rendererName: string;
    scene: ConformanceScene;
    width: number;
    height: number;
    labels: string[] | null;
    labelNote?: string;
    problems: string[];
    fixtureRequests: string[];
    fixtureMisses: string[];
    recorded: string[];
    durationMs: number;
    meta?: Record<string, unknown>;
  };
  export const VIEWPORT: {width: number; height: number};
  export function selectScenes(selection: string | undefined): ConformanceScene[];
  export function createContainer(): HTMLDivElement;
  export function readCanvas(source: CanvasImageSource): Uint8ClampedArray;
  export function withTimeout<T>(promise: Promise<T>, label: string, timeout?: number): Promise<T>;
  export function runConformanceScene(renderer: ConformanceRenderer, scene: ConformanceScene): Promise<SavedRender>;
  export function createMapLibreRenderer(
    dependencies: {maplibregl: unknown; styleSpec: {expression: unknown; latest: unknown}},
    id?: string
  ): ConformanceRenderer;
}

declare module '*?url' {
  const url: string;
  export default url;
}
