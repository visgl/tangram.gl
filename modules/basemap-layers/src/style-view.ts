// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {BasemapStyle, ResolvedBasemapStyle} from './style-resolver';

/** The deck.gl projection to use with a style. */
export type StyleProjection = 'mercator' | 'globe';

/** The initial deck.gl camera derived from a style. */
export type StyleViewState = {
  longitude: number;
  latitude: number;
  zoom: number;
  bearing: number;
  pitch: number;
};

/** The projection and initial camera derived from a style. */
export type StyleView = {projection: StyleProjection; viewState: StyleViewState};

/** Reads the projection and camera synchronously. Resolve style URLs with `resolveBasemapStyle` first. */
export function getStyleView(style: BasemapStyle | ResolvedBasemapStyle): StyleView {
  const {center, zoom, bearing, pitch} = style;
  const [longitude, latitude] = Array.isArray(center) && center.length === 2 ? center : [];
  const validCenter = isFiniteNumber(longitude) && isFiniteNumber(latitude);

  return {
    projection: getStyleProjection(style) ?? 'mercator',
    viewState: {
      longitude: validCenter ? longitude : 0,
      latitude: validCenter ? latitude : 0,
      zoom: isFiniteNumber(zoom) ? zoom : 0,
      bearing: isFiniteNumber(bearing) ? bearing : 0,
      pitch: isFiniteNumber(pitch) ? pitch : 0
    }
  };
}

/** Returns the declared projection, or null when the style has no valid projection. */
export function getStyleProjection(
  style: BasemapStyle | ResolvedBasemapStyle
): StyleProjection | null {
  const {projection} = style;
  if (!projection || typeof projection !== 'object' || !('type' in projection)) {
    return null;
  }
  const {type} = projection;
  if (containsGlobeProjection(type)) {
    return 'globe';
  }
  return type === 'mercator' || Array.isArray(type) ? 'mercator' : null;
}

function containsGlobeProjection(value: unknown): boolean {
  return Array.isArray(value)
    ? value.some(containsGlobeProjection)
    : value === 'globe' || value === 'vertical-perspective';
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
