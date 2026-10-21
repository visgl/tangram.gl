// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {LngLat, MapOptions} from 'maplibre-gl';
import {normalizeComparisonCamera, type ComparisonCamera} from './comparison-style';

/**
 * Share explicit camera bounds without MapLibre's viewport-dependent zoom/center correction.
 * Inject center construction to keep the MapLibre runtime behind the cancellable import.
 */
export function createComparisonCameraOptions(camera: ComparisonCamera, viewMode: string,
  createCenter: (longitude: number, latitude: number) => LngLat
): Pick<MapOptions, 'center' | 'zoom' | 'bearing' | 'pitch' | 'minZoom' | 'maxZoom' | 'maxPitch' | 'transformConstrain'> {
  const normalized = normalizeComparisonCamera(camera, viewMode);
  return {
    center: [normalized.longitude, normalized.latitude], zoom: normalized.zoom,
    bearing: normalized.bearing, pitch: normalized.pitch,
    minZoom: 0, maxZoom: 20, maxPitch: viewMode === 'mapPerspective' ? 50 : 0,
    transformConstrain(center, zoom) {
      const constrained = normalizeComparisonCamera({longitude: center.lng, latitude: center.lat, zoom}, viewMode);
      return {center: createCenter(constrained.longitude, constrained.latitude), zoom: constrained.zoom};
    }
  };
}
