// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {createBasemapBackground} from './basemap-background';
import {createUnlitVectorStyles} from './basemap-styling';
import {STREETS_COLORS, STREETS_BUILDING_MIN_ZOOM, STREETS_PLACE_LABELS, createStreetsRoadRules} from './streets-cartography';

/** Inputs that differ between the example and hermetic harnesses; the cartography does not. */
export interface StreetsSceneOptions {
  /** OpenMapTiles source, e.g. `createVectorSource(provider)` or a recorded fixture template. */
  vectorSource: Record<string, unknown>;
  /** URL of the Montserrat web font used by place names. */
  fontUrl: string;
  /** Draw place names. */
  labels?: boolean;
  /** Make place names pickable, so a harness can read back which ones were placed. */
  interactiveLabels?: boolean;
}

/** The Streets example scene: flat unlit polygons, graded roads and place names. */
export function createStreetsScene({vectorSource, fontUrl, labels = true, interactiveLabels = false}: StreetsSceneOptions) {
  const background = createBasemapBackground(STREETS_COLORS.background);
  const scene = {
    scene: {background: {color: STREETS_COLORS.background}},
    fonts: {[STREETS_PLACE_LABELS.family]: {url: fontUrl}},
    sources: {...background.sources, basemap: vectorSource},
    styles: {...background.styles, ...createUnlitVectorStyles()},
    layers: {
      ...background.layers,
      landcover: {data: {source: 'basemap', layer: 'landcover'},
        draw: {polygons: {style: 'basemap-polygons', order: 1, color: STREETS_COLORS.landcover}}},
      landuse: {data: {source: 'basemap', layer: 'landuse'},
        draw: {polygons: {style: 'basemap-polygons', order: 2, color: STREETS_COLORS.landuse}}},
      parks: {data: {source: 'basemap', layer: 'park'},
        draw: {polygons: {style: 'basemap-polygons', order: 3, color: STREETS_COLORS.park}}},
      water: {data: {source: 'basemap', layer: 'water'},
        draw: {polygons: {style: 'basemap-polygons', order: 4, color: STREETS_COLORS.water}}},
      waterways: {data: {source: 'basemap', layer: 'waterway'},
        draw: {lines: {style: 'basemap-lines', order: 5, color: STREETS_COLORS.waterway, width: '1px'}}},
      buildings: {data: {source: 'basemap', layer: 'building'}, filter: {$zoom: {min: STREETS_BUILDING_MIN_ZOOM}},
        draw: {polygons: {style: 'basemap-polygons', order: 6, color: STREETS_COLORS.building}}},
      roads: createStreetsRoadRules(),
      places: {
        data: {source: 'basemap', layer: 'place'},
        draw: {text: {
          order: 8,
          text_source: 'name',
          ...(interactiveLabels ? {interactive: true} : {}),
          font: {
            family: STREETS_PLACE_LABELS.family,
            size: STREETS_PLACE_LABELS.sizes.map(([zoom, pixels]) => [zoom, `${pixels}px`]),
            fill: STREETS_PLACE_LABELS.fill,
            stroke: {color: STREETS_PLACE_LABELS.stroke, width: STREETS_PLACE_LABELS.strokeWidth}
          }
        }}
      }
    } as Record<string, unknown>
  };
  if (!labels) {
    delete scene.layers.places;
  }
  return scene;
}
