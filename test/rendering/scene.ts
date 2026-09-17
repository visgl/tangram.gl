// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/** A tiny authored GeoJSON corpus: roads and extruded buildings near the origin. */
export const FIXTURE = {
  type: 'FeatureCollection',
  features: [
    ...[-0.002, 0, 0.002].map(latitude => ({
      type: 'Feature', properties: {kind: 'road'},
      geometry: {type: 'LineString', coordinates: [[-0.015, latitude], [0.015, latitude]]}
    })),
    ...[-0.002, 0, 0.002].map(longitude => ({
      type: 'Feature', properties: {kind: 'road'},
      geometry: {type: 'LineString', coordinates: [[longitude, -0.015], [longitude, 0.015]]}
    })),
    ...[-1, 1].map(direction => ({
      type: 'Feature', id: direction + 2, properties: {kind: 'building', name: 'fixture-building'},
      geometry: {type: 'Polygon', coordinates: [[
        [direction * 0.0005, 0.0005], [direction * 0.0015, 0.0005],
        [direction * 0.0015, 0.0015], [direction * 0.0005, 0.0015],
        [direction * 0.0005, 0.0005]
      ]]}
    }))
  ]
};

/** Nested GeoJSON coordinate values, excluding feature IDs and properties. */
type Coordinates = number | Coordinates[];

/** Scale only geographic coordinates for the globe's regional fixture. */
function scaleCoordinates(coordinates: Coordinates, scale: number): Coordinates {
  return Array.isArray(coordinates)
    ? coordinates.map(value => scaleCoordinates(value, scale)) : coordinates * scale;
}

/** Use identical topology at city and globe scales. */
export function createFixture(scale: number) {
  return {...FIXTURE, features: FIXTURE.features.map(feature => ({
    ...feature,
    geometry: {...feature.geometry, coordinates: scaleCoordinates(feature.geometry.coordinates, scale)}
  }))};
}

/** Build an offline scene, including the shader macro that once broke TRON on WebGL. */
export function createScene(url: string, color = '#20d0b0', animated = false, scale = 1) {
  return {
    scene: {animated, background: {color: '#000000'}},
    sources: {fixture: {type: 'GeoJSON', url, max_zoom: 18}},
    lights: {ambient: {type: 'ambient', ambient: 1}},
    styles: {
      traffic: {
        base: 'lines', texcoords: true, animated,
        shaders: {blocks: {
          global: '#define HALF_PI 1.57079632679',
          color: animated
            ? 'color.rgb *= 0.25 + 0.75 * step(0.5, fract(v_texcoord.y * 0.05 - u_time * 0.7));'
            : ''
        }}
      }
    },
    layers: {
      roads: {
        data: {source: 'fixture'}, filter: {kind: 'road'},
        draw: {traffic: {order: 2, color, width: '10px'}}
      },
      buildings: {
        data: {source: 'fixture'}, filter: {kind: 'building'},
        draw: {polygons: {order: 1, color, extrude: 80 * scale, interactive: true}}
      }
    }
  };
}

/** Generate a small texture in memory; raster tests never use a basemap service. */
export function createRasterScene() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const context = canvas.getContext('2d')!;
  context.fillStyle = '#203080';
  context.fillRect(0, 0, 64, 64);
  context.fillStyle = '#e07020';
  context.fillRect(0, 0, 32, 32);
  context.fillRect(32, 32, 32, 32);
  return {
    scene: {background: {color: '#000000'}},
    // A fragment carries tile coordinates without changing the local PNG bytes.
    sources: {fixture: {type: 'Raster', url: `${canvas.toDataURL('image/png')}#/{z}/{x}/{y}`, max_zoom: 18}},
    layers: {basemap: {data: {source: 'fixture'}, draw: {raster: {order: 0}}}}
  };
}
