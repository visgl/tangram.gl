// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {Device, RenderPass} from '@luma.gl/core';
import type {DecodedTileStatistics} from './sources/decoded_tile_store';
import type {
  GlobeVisibilityLODAdapter,
  VisibilityLODAdapter
} from './scene/visibility_adapter.js';

export type Matrix4 = readonly number[] | Float32Array | Float64Array;
export type Vector3 = readonly [number, number, number];
export type SceneDefinition = string | Record<string, unknown> | readonly SceneDefinition[];

/** Minimal CRS options accepted by a caller-owned math.gl-compatible projection factory. */
export interface ProjectionEngineOptions {
  /** Source CRS, supplied by Tangram as geographic degrees. */
  from?: string;
  /** Destination CRS, supplied by Tangram as north-positive projected meters. */
  to?: string;
}

/** Compiled projection surface used for packed worker mesh coordinates. */
export interface ProjectionEngineTransform {
  /** Project packed coordinates in place, preserving their typed-array representation. */
  projectFlatSync(coordinates: Float64Array, dimension?: number): Float64Array;
}

/** Structural subset of math.gl's factory; ordinary consumers need not install the optional peer. */
export interface ProjectionEngine {
  /** Compile an independent transform synchronously. */
  createProjection(options?: ProjectionEngineOptions): ProjectionEngineTransform;
  /** Compile a transform after loading any registered lazy projection implementations. */
  createProjectionAsync(options?: ProjectionEngineOptions): Promise<ProjectionEngineTransform>;
}

export type Viewport = {
  x?: number;
  y?: number;
  width: number;
  height: number;
};

export type GeographicAnchor = {
  longitude: number;
  latitude: number;
  altitude?: number;
  zoom: number;
};

/** Geographic projection used by host-provided positions and camera matrices. */
export type HostProjection =
    | {
      /** Worker-projected flat common coordinates; requires an explicit geographic footprint. */
      type: 'projected';
      /** Ordered unwrapped footprint in degrees; tile selection remains Web Mercator XYZ. */
      visibleBounds: readonly [number, number, number, number];
    }
  | {
      type: 'web-mercator';
      /** Explicit unwrapped geographic footprint; null means no visible ground, omitted uses camera/legacy bounds. */
      visibleBounds?: readonly [number, number, number, number] | null;
    }
  | {
      type: 'globe';
      /** Conservative footprint enclosing ground and elevated content: west, south, east, north. */
      visibleBounds: readonly [number, number, number, number];
      /**
       * Conservative maximum rendered elevation in geographic meters above the reference sphere.
       * Zero declares a surface-only scene. Omitted means unknown and disables horizon rejection.
       * Includes terrain, extrusion, offsets and shader displacement; never inferred from camera altitude.
       */
      maxElevation?: number;
    };

export type HostCamera = {
  view: Matrix4;
  projection: Matrix4;
  position: Vector3;
};

export type HostRenderView = {
  id?: string;
  viewport?: Viewport;
  camera: HostCamera;
  /** Optional per-eye footprint anchor; scene/style state still uses the shared anchor. */
  geographicAnchor?: GeographicAnchor;
  /** Optional per-eye geographic bounds for union visibility. */
  projection?: HostProjection;
};

/** Opt-in uniform data LOD estimated from projected surface scale across all eyes. */
export type HostTileLODOptions = {
  /** Target projected tile edge in device pixels; defaults to 512. */
  targetTilePixels?: number;
  /** Device pixels per viewport CSS pixel; defaults to 1. */
  pixelRatio?: number;
  /** Buffered candidate visits across eyes, before deduplication; defaults to 256. */
  maxTiles?: number;
  /** Zoom-level dead band around transitions; defaults to 0.2. */
  hysteresis?: number;
};

/** Opt-in worker scheduling and completed off-screen mesh cache limits, shared by all eyes. */
export type HostTileResourceOptions = {
  /** Maximum concurrently submitted tile builds across sources; positive integer, omitted is unlimited. */
  maxConcurrentBuilds?: number;
  /** Maximum completed off-screen cache entries; non-negative integer, omitted is unlimited. */
  maxCachedTiles?: number;
  /** Cached vertex/index bytes, including globe variants and pending labels; non-negative integer. */
  maxCachedMeshBytes?: number;
};

/** Detached renderer resource accounting; textures, CPU data and driver overhead are not included. */
export type TileResourceStatistics = {
  /** Tile builds submitted to workers, not individual network requests. */
  activeBuilds: number;
  /** Source/style tile builds waiting for a scheduling slot. */
  queuedBuilds: number;
  /** All retained tiles, including visible/proxy/preload and incomplete builds. */
  residentTiles: number;
  /** Completed tiles eligible for cache eviction. */
  cachedTiles: number;
  /** Vertex/index bytes owned by evictable tiles. */
  cachedMeshBytes: number;
  /** Tiles protected from resource-policy eviction. */
  protectedTiles: number;
  /** Vertex/index bytes owned by protected tiles. */
  protectedMeshBytes: number;
};

/** Worker-local decoded acquisition accounting, separate from scene-wide mesh-build statistics. */
export type TileSourceStatistics = DecodedTileStatistics & {
  /** Index of the worker in the scene's current worker pool. */
  workerId: number;
  /** False for workers with external source scripts; custom pipelines always bypass sharing. */
  sharingEnabled: boolean;
};

export type HostFrameOptions = {
  viewport: Viewport;
  geographicAnchor: GeographicAnchor;
  projection?: HostProjection;
  renderViews: readonly HostRenderView[];
  activeRenderViewId?: string;
  tileBuffer?: number;
  /** Optional shared data-tile zoom (integer 0–22, no higher than the shared style zoom). */
  tileZoom?: number;
  /** Automatic shared data LOD; mutually exclusive with tileZoom. */
  tileLOD?: HostTileLODOptions;
  /** Opt-in scheduling/cache policy shared by every render view and source. */
  tileResources?: HostTileResourceOptions;
  /** Retain a global coarse level for globe loading gaps; integer 0–3, omitted disables preloading. */
  globePreloadZoom?: number;
  /** Shared elapsed scene animation time in seconds. */
  animationTime?: number;
};

export type LegacyHostFrame = {
  viewport: Viewport;
  view: GeographicAnchor;
  projection?: HostProjection;
  camera: HostCamera;
  tileBuffer?: number;
  /** Optional shared data-tile zoom; omission preserves zoom-driven selection. */
  tileZoom?: number;
  /** Opt-in projected-scale data LOD. */
  tileLOD?: HostTileLODOptions;
  /** Opt-in scheduling/cache policy; omission restores unlimited scheduling/cache defaults. */
  tileResources?: HostTileResourceOptions;
  /** Optional bounded global globe fallback level, integer 0–3. */
  globePreloadZoom?: number;
  /** Shared elapsed scene animation time in seconds. */
  animationTime?: number;
};

export type RendererOptions = {
  /** Optional caller-owned CRS factory for CPU-projected basemaps; ordinary Mercator/globe cameras are unchanged. */
  projectionEngine?: ProjectionEngine;
  device?: Device;
  /** Optional worker script URL; otherwise the package uses its embedded worker. */
  workerURL?: string;
  /** Renderer-owned policy for viewport bounds and tile visibility/LOD. */
  visibilityAdapter?: VisibilityLODAdapter;
  /** Renderer-owned policy for selecting tiles for globe projection bounds. */
  globeVisibilityAdapter?: GlobeVisibilityLODAdapter;
  canvas?: HTMLCanvasElement | OffscreenCanvas;
  requestRedraw?: () => void;
  numWorkers?: number;
  /** Positive safe integer limit for shared built-in tile loads in each worker; omitted is unlimited. */
  maxConcurrentTileLoadsPerWorker?: number;
  logLevel?: string;
  highDensityDisplay?: boolean;
  introspection?: boolean;
  [option: string]: unknown;
};

export type SceneLoadOptions = {
  base_path?: string;
  file_type?: string;
  blocking?: boolean;
  [option: string]: unknown;
};

export type SceneUpdateOptions = {
  loading?: boolean;
  rebuild?: boolean | Record<string, unknown>;
  serialize_funcs?: boolean;
  texture_nodes?: Record<string, unknown>;
  normalize?: boolean;
  fade_in?: boolean;
};

export type SceneDataSource = {
  type: string;
  /** Required provider credit HTML for the host to display safely. */
  attribution?: string;
  url?: string;
  tilejson?: string | Record<string, unknown>;
  data?: unknown;
  [property: string]: unknown;
};

export type SceneFeature = {
  id?: string | number;
  properties: Record<string, unknown>;
  geometry?: Record<string, unknown>;
  [property: string]: unknown;
};

export type SceneQueryOptions = {
  filter?: unknown;
  unique?: boolean | string | readonly string[];
  group_by?: string | readonly string[] | null;
  visible?: boolean | null;
  geometry?: boolean;
};

export type SceneScreenshot = {
  url: string;
  blob: Blob;
  type: 'png';
};

export type RenderOptions = {
  frame?: HostFrameOptions | LegacyHostFrame;
  renderPass?: RenderPass | null;
  renderViewId?: string;
  force?: boolean;
};

export type SceneConfigEvent = {config: Record<string, unknown>};
export type SceneErrorEvent = {
  type?: string;
  message?: string;
  error?: unknown;
  [property: string]: unknown;
};

export type SceneEventMap = {
  load: [event: SceneConfigEvent];
  update: [event: SceneConfigEvent];
  pre_update: [willRender: boolean];
  post_update: [willRender: boolean];
  view_complete: [event: {first: boolean}];
  error: [event: SceneErrorEvent];
  warning: [event: SceneErrorEvent];
  move: [];
};

export type SceneListener<EventName extends keyof SceneEventMap = keyof SceneEventMap> = (
  ...arguments_: SceneEventMap[EventName]
) => void;

export type SceneListeners = {
  [EventName in keyof SceneEventMap]?: SceneListener<EventName>;
} & {
  [event: string]: ((...arguments_: never[]) => void) | undefined;
};

export type WorkerRequest<Message = unknown> = {
  type: 'main_send' | 'worker_send';
  message_id: number;
  method: string;
  message: Message;
};

export type WorkerResponse<Message = unknown> = {
  type: 'main_reply' | 'worker_reply';
  message_id: number;
  message?: Message;
  error?: string;
};

export type WorkerBrokerMessage<Message = unknown> =
  | WorkerRequest<Message>
  | WorkerResponse<Message>;
