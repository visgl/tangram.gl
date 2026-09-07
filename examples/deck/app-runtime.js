// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {Deck, FirstPersonView, MapView, _GlobeView as GlobeView} from '@deck.gl/core';
import {PathLayer, ScatterplotLayer} from '@deck.gl/layers';
import {webgpuAdapter} from 'https://esm.sh/@luma.gl/webgpu@9.4.0?bundle&external=@luma.gl/core';
import {TangramLayer} from '@vis.gl/tangram-layers';
import {resolveDeckExampleViewMode} from './app-loader.js';

export function initializeDeckExample({
  embeddedViewMode,
  basemapId: configuredBasemapId,
  showOverlays = true
} = {}) {
  const exampleBaseUrl = window.tangramExampleBaseUrl || new URL('./', import.meta.url).href;

  function resolveExampleAsset(relativePath) {
    return new URL(relativePath, exampleBaseUrl).href;
  }

  const searchParams = new URLSearchParams(window.location.search);
  const requestedBackend = searchParams.get('device');
  const defaultDeviceType = 'webgpu';
  const deviceType = requestedBackend || (navigator.gpu ? defaultDeviceType : 'webgl');
  const useWebGPU = deviceType === 'webgpu';
  const enablePortableText = !useWebGPU || searchParams.get('portable_text') !== '0';
  const enablePortableTraffic = !useWebGPU || searchParams.get('traffic') !== '0';
  const pointProbe = useWebGPU ? searchParams.get('points') : null;
  const lineProbe = searchParams.has('line_probe') && searchParams.get('line_probe') !== '0';
  let apiKey =
    searchParams.get('api_key') || window.sessionStorage.getItem('tangram-nextzen-api-key');
  if (searchParams.has('api_key')) {
    window.sessionStorage.setItem('tangram-nextzen-api-key', apiKey);
    const sanitizedUrl = new URL(window.location.href);
    sanitizedUrl.searchParams.delete('api_key');
    window.history.replaceState(null, '', sanitizedUrl);
  }
  const BASEMAPS = {
    streetsVector: {
      label: 'Streets vector tiles',
      scene: createVectorScene({labels: enablePortableText}),
      deviceTypes: ['webgl', 'webgpu']
    },
    positronRaster: {
      label: 'Positron raster tiles',
      scene: createRasterScene('https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png'),
      deviceTypes: ['webgl', 'webgpu']
    },
    tron: {
      label: 'TRON 2.0 shaders on vector tiles',
      scene: createTronCartoScene({
        portable: useWebGPU,
        labels: enablePortableText,
        animateTraffic: enablePortableTraffic,
        pointProbe,
        lineProbe
      }),
      deviceTypes: ['webgl', 'webgpu'],
      webgpuStatus: enablePortableTraffic
        ? 'Portable cyan and purple palette with animated highway traffic.'
        : 'Portable cyan and purple palette; traffic animation is paused.'
    },
    tronNextzen: {
      label: 'Original TRON 2.0 on Nextzen tiles',
      scene: createTronNextzenScene(apiKey),
      deviceTypes: ['webgl'],
      requiresApiKey: true
    }
  };

  const mapViewState = {
    longitude: -74.009764,
    latitude: 40.705319,
    zoom: 15,
    bearing: -20,
    pitch: 35
  };

  const mapController = {
    dragRotate: true,
    touchRotate: true,
    maxPitch: 50
  };

  const VIEW_MODES = {
    mapFlat: {
      label: 'MapView — flat',
      view: new MapView({id: 'main', orthographic: true, controller: true}),
      initialViewState: {...mapViewState, bearing: 0, pitch: 0},
      supportsTangram: true
    },
    mapPerspective: {
      label: 'MapView — perspective',
      view: new MapView({id: 'main', controller: mapController}),
      initialViewState: mapViewState,
      supportsTangram: true
    },
    globe: {
      label: 'GlobeView — experimental',
      view: new GlobeView({id: 'main', controller: true}),
      initialViewState: {
        longitude: mapViewState.longitude,
        latitude: mapViewState.latitude,
        zoom: 3
      },
      supportsTangram: true
    },
    firstPerson: {
      label: 'FirstPersonView',
      view: new FirstPersonView({id: 'main', controller: true, far: 20000}),
      initialViewState: {
        longitude: mapViewState.longitude,
        latitude: mapViewState.latitude,
        position: [0, 0, 600],
        bearing: 0,
        pitch: 60
      },
      supportsTangram: true
    }
  };

  const viewModeId = resolveDeckExampleViewMode({
    embeddedViewMode,
    queryViewMode: searchParams.get('view'),
    viewModes: VIEW_MODES
  });
  const viewMode = VIEW_MODES[viewModeId];

  const landmarks = [
    {name: 'One World Trade Center', coordinates: [-74.013379, 40.712743]},
    {name: 'Brooklyn Bridge', coordinates: [-73.996864, 40.706086]}
  ];

  const bridgePath = [
    [-74.013379, 40.712743],
    [-74.009764, 40.705319],
    [-73.996864, 40.706086]
  ];

  const globeLandmarks = [
    {name: 'New York', coordinates: [-74.009764, 40.705319]},
    {name: 'London', coordinates: [-0.1276, 51.5072]},
    {name: 'Tokyo', coordinates: [139.6917, 35.6895]},
    {name: 'San Francisco', coordinates: [-122.4194, 37.7749]}
  ];

  const globePath = globeLandmarks.map((landmark) => landmark.coordinates);
  globePath.push(globePath[0]);

  const overlayParameters = {
    depthCompare: 'always',
    depthWriteEnabled: false
  };

  const statusElement = document.getElementById('status');
  const visibilityInput = document.getElementById('basemap-visible');
  const basemapSelect = document.getElementById('basemap-style');
  const viewSelect = document.getElementById('view-type');
  const deviceTabButtons = document.querySelectorAll('[data-device-type]');
  const infoTabButtons = document.querySelectorAll('[data-example-tab]');
  const infoTabPanels = document.querySelectorAll('[data-example-tab-panel]');
  const fullscreenButton = document.getElementById('example-fullscreen');
  const fullscreenTarget = document.getElementById('deck-container');
  const cartoAttribution = document.getElementById('carto-attribution');
  const nextzenAttribution = document.getElementById('nextzen-attribution');
  const tronSourceLink = document.getElementById('tron-source-link');
  const nextzenKeyForm = document.getElementById('nextzen-key-form');
  const nextzenKeyInput = document.getElementById('nextzen-api-key');
  nextzenKeyInput.value = apiKey || '';
  if (viewSelect) {
    viewSelect.value = viewModeId;
  }
  for (const button of deviceTabButtons) {
    const isActive = button.dataset.deviceType === deviceType;
    button.classList.toggle('is-active', isActive);
    button.setAttribute('aria-selected', String(isActive));
  }
  const defaultBasemapId = configuredBasemapId || 'tron';
  const requestedBasemapId = searchParams.get('basemap');
  const initialBasemapId =
    !configuredBasemapId &&
    requestedBasemapId &&
    BASEMAPS[requestedBasemapId] &&
    BASEMAPS[requestedBasemapId].deviceTypes.includes(deviceType)
      ? requestedBasemapId
      : defaultBasemapId;
  basemapSelect.value = initialBasemapId;
  let basemapVisible = true;
  let basemapId = initialBasemapId;
  let lastError = null;
  let nextzenKeyValidated = false;
  let nextzenKeyValidationGeneration = 0;

  function setStatus(message, type = '') {
    if (type === 'error') {
      lastError = message;
    } else if (lastError) {
      return;
    }
    statusElement.textContent = message;
    statusElement.dataset.type = type;
  }

  function createLayers() {
    const basemap = BASEMAPS[basemapId];
    const layers = [];
    const usesGlobeOverlay = viewModeId === 'globe';
    const overlayLandmarks = usesGlobeOverlay ? globeLandmarks : landmarks;
    const overlayPath = usesGlobeOverlay ? globePath : bridgePath;
    if (viewMode.supportsTangram && (!basemap.requiresApiKey || (apiKey && nextzenKeyValidated))) {
      layers.push(
        new TangramLayer({
          id: 'tangram-basemap',
          scene: basemap.scene,
          apiKey,
          visible: basemapVisible,
          onSceneLoad: () => {
            const message = `${basemap.label} loaded through Tangram`;
            setStatus(
              useWebGPU && basemap.webgpuStatus ? `${message}. ${basemap.webgpuStatus}` : message,
              useWebGPU && basemap.webgpuStatus ? 'warning' : 'success'
            );
          },
          onSceneError: (error) => setStatus(error.message, 'error')
        })
      );
    }
    if (showOverlays) {
      layers.push(
        new PathLayer({
          id: 'alignment-path',
          data: [{path: overlayPath}],
          getPath: (object) => object.path,
          getColor: () => [255, 96, 32, 220],
          getWidth: () => 6,
          widthUnits: 'pixels',
          parameters: overlayParameters
        }),
        new ScatterplotLayer({
          id: 'alignment-landmarks',
          data: overlayLandmarks,
          getPosition: (object) => object.coordinates,
          getRadius: () => (usesGlobeOverlay ? 7 : 35),
          radiusUnits: usesGlobeOverlay ? 'pixels' : 'meters',
          getFillColor: () => [30, 144, 255, 220],
          getLineColor: () => [255, 255, 255, 255],
          lineWidthMinPixels: 2,
          stroked: true,
          pickable: true,
          parameters: overlayParameters
        })
      );
    }
    return layers;
  }

  function updateBasemapPresentation() {
    const basemap = BASEMAPS[basemapId];
    const isTron = basemapId === 'tron' || basemapId === 'tronNextzen';
    const usesNextzen = basemapId === 'tronNextzen';
    cartoAttribution.hidden = usesNextzen;
    nextzenAttribution.hidden = !usesNextzen;
    tronSourceLink.hidden = !isTron;
    nextzenKeyForm.hidden = !usesNextzen;
    basemapSelect.disabled = !viewMode.supportsTangram;
    visibilityInput.disabled = !viewMode.supportsTangram;

    lastError = null;
    if (!viewMode.supportsTangram) {
      setStatus(viewMode.limitation, 'warning');
    } else if (basemap.requiresApiKey && !apiKey) {
      setStatus(
        'Original TRON requires an existing Nextzen key; new signups are closed. Enter a key below.',
        'error'
      );
    } else if (basemap.requiresApiKey && !nextzenKeyValidated) {
      setStatus(`Checking the existing Nextzen key for ${window.location.origin}…`, 'warning');
    } else {
      setStatus(`Loading ${basemap.label} through Tangram on ${deviceType}…`);
    }
  }

  let deckInstance;
  try {
    deckInstance = new Deck({
      parent: document.getElementById('deck-container'),
      deviceProps: useWebGPU
        ? {
            type: 'webgpu',
            adapters: [webgpuAdapter]
          }
        : {type: 'webgl'},
      views: viewMode.view,
      initialViewState: viewMode.initialViewState,
      layers: createLayers(),
      getTooltip: ({object}) => object && object.name,
      onError: (error) => {
        setStatus(error.message, 'error');
        return true;
      }
    });
  } catch (error) {
    setStatus(error.message, 'error');
    throw error;
  }

  updateBasemapPresentation();
  if (basemapId === 'tronNextzen' && apiKey) {
    validateNextzenKey();
  }

  for (const button of deviceTabButtons) {
    button.addEventListener('click', () => {
      const nextDeviceType = button.dataset.deviceType;
      const url = new URL(window.location.href);
      url.searchParams.set('device', nextDeviceType);
      if (!BASEMAPS[basemapId].deviceTypes.includes(nextDeviceType)) {
        url.searchParams.delete('basemap');
      }
      window.location.assign(url);
    });
  }

  viewSelect?.addEventListener('change', (event) => {
    const url = new URL(window.location.href);
    url.searchParams.set('view', event.target.value);
    window.location.assign(url);
  });

  for (const button of infoTabButtons) {
    button.addEventListener('click', () => {
      for (const candidate of infoTabButtons) {
        const isActive = candidate === button;
        candidate.classList.toggle('is-active', isActive);
        candidate.setAttribute('aria-selected', String(isActive));
      }
      for (const panel of infoTabPanels) {
        panel.hidden = panel.dataset.exampleTabPanel !== button.dataset.exampleTab;
      }
    });
  }

  function updateFullscreenButton() {
    if (!fullscreenButton) {
      return;
    }
    const isFullscreen = document.fullscreenElement === fullscreenTarget;
    fullscreenButton.classList.toggle('is-active', isFullscreen);
    fullscreenButton.setAttribute(
      'aria-label',
      isFullscreen ? 'Exit fullscreen example' : 'Open fullscreen example'
    );
    fullscreenButton.title = isFullscreen ? 'Exit fullscreen' : 'Fullscreen';
  }

  fullscreenButton?.addEventListener('click', async () => {
    if (document.fullscreenElement === fullscreenTarget) {
      await document.exitFullscreen();
    } else {
      await fullscreenTarget.requestFullscreen();
    }
  });
  document.addEventListener('fullscreenchange', updateFullscreenButton);
  updateFullscreenButton();

  visibilityInput.addEventListener('change', (event) => {
    basemapVisible = event.target.checked;
    deckInstance.setProps({layers: createLayers()});
  });

  basemapSelect.addEventListener('change', (event) => {
    const selectedBasemapId = event.target.value;
    const selectedBasemap = BASEMAPS[selectedBasemapId];
    if (!selectedBasemap.deviceTypes.includes(deviceType)) {
      const url = new URL(window.location.href);
      url.searchParams.set('device', selectedBasemap.deviceTypes[0]);
      url.searchParams.set('basemap', selectedBasemapId);
      window.location.assign(url);
      return;
    }

    basemapId = selectedBasemapId;
    const url = new URL(window.location.href);
    url.searchParams.set('basemap', basemapId);
    window.history.replaceState(null, '', url);
    updateBasemapPresentation();
    if (basemapId === 'tronNextzen' && apiKey && !nextzenKeyValidated) {
      validateNextzenKey();
    } else {
      deckInstance.setProps({layers: createLayers()});
    }
  });

  nextzenKeyForm.addEventListener('submit', (event) => {
    event.preventDefault();
    apiKey = nextzenKeyInput.value.trim();
    if (apiKey) {
      window.sessionStorage.setItem('tangram-nextzen-api-key', apiKey);
    } else {
      window.sessionStorage.removeItem('tangram-nextzen-api-key');
    }
    BASEMAPS.tronNextzen.scene = createTronNextzenScene(apiKey);
    validateNextzenKey();
  });

  async function validateNextzenKey() {
    const validationGeneration = ++nextzenKeyValidationGeneration;
    nextzenKeyValidated = false;
    updateBasemapPresentation();
    deckInstance.setProps({layers: createLayers()});
    if (!apiKey) {
      return;
    }

    try {
      const response = await fetch(
        'https://tile.nextzen.org/tilezen/vector/v1/512/all/0/0/0.mvt' +
          `?api_key=${encodeURIComponent(apiKey)}`
      );
      if (!response.ok) {
        const detail = (await response.text()).trim();
        throw new Error(detail || `HTTP ${response.status}`);
      }
      if (validationGeneration !== nextzenKeyValidationGeneration) {
        return;
      }
      nextzenKeyValidated = true;
      updateBasemapPresentation();
      deckInstance.setProps({layers: createLayers()});
    } catch (error) {
      if (validationGeneration !== nextzenKeyValidationGeneration) {
        return;
      }
      lastError = null;
      setStatus(
        `Nextzen rejected the key for ${window.location.origin}: ${error.message}`,
        'error'
      );
    }
  }

  function createRasterScene(url) {
    return {
      sources: {
        carto: {
          type: 'Raster',
          url,
          max_zoom: 20
        }
      },
      layers: {
        basemap: {
          data: {source: 'carto'},
          draw: {
            raster: {order: 0}
          }
        }
      }
    };
  }

  function createVectorScene({labels = true} = {}) {
    const scene = {
      scene: {
        background: {color: '#f5f3ef'}
      },
      fonts: {
        Montserrat: {url: resolveExampleAsset('../classic/fonts/montserrat.woff')}
      },
      sources: {
        carto: {
          type: 'MVT',
          url: 'https://tiles-a.basemaps.cartocdn.com/vectortiles/carto.streets/v1/{z}/{x}/{y}.mvt',
          tile_size: 512,
          max_zoom: 14
        }
      },
      layers: {
        landcover: {
          data: {source: 'carto', layer: 'landcover'},
          draw: {
            polygons: {order: 1, color: '#e8eee5'}
          }
        },
        landuse: {
          data: {source: 'carto', layer: 'landuse'},
          draw: {
            polygons: {order: 2, color: '#eeeae2'}
          }
        },
        parks: {
          data: {source: 'carto', layer: 'park'},
          draw: {
            polygons: {order: 3, color: '#cfe5c8'}
          }
        },
        water: {
          data: {source: 'carto', layer: 'water'},
          draw: {
            polygons: {order: 4, color: '#b9d9e7'}
          }
        },
        waterways: {
          data: {source: 'carto', layer: 'waterway'},
          draw: {
            lines: {order: 5, color: '#a4cfdf', width: '1px'}
          }
        },
        buildings: {
          data: {source: 'carto', layer: 'building'},
          filter: {$zoom: {min: 14}},
          draw: {
            polygons: {order: 6, color: '#ded8d0'}
          }
        },
        roads: {
          data: {source: 'carto', layer: 'transportation'},
          draw: {
            lines: {
              order: () => {
                var classOrder = {
                  path: 0,
                  track: 1,
                  service: 2,
                  minor: 3,
                  tertiary: 4,
                  secondary: 5,
                  primary: 6,
                  trunk: 7,
                  motorway: 8
                };
                var layer = parseInt(feature.layer, 10) || 0;
                if (layer === 0 && feature.brunnel === 'bridge') {
                  layer = 1;
                } else if (layer === 0 && feature.brunnel === 'tunnel') {
                  layer = -1;
                }
                layer = Math.max(-5, Math.min(5, layer));
                return 128 + layer * 16 + (classOrder[feature.class] || 0);
              },
              color: '#ffffff',
              width: [
                [8, '0.5px'],
                [12, '1px'],
                [16, '3px']
              ],
              outline: {color: '#d5d0c8', width: '1px'}
            }
          },
          major: {
            filter: {class: ['motorway', 'trunk', 'primary', 'secondary']},
            draw: {
              lines: {
                color: '#f5c879',
                width: [
                  [8, '1px'],
                  [12, '2px'],
                  [16, '7px']
                ],
                outline: {color: '#d4aa65', width: '1px'}
              }
            }
          }
        },
        places: {
          data: {source: 'carto', layer: 'place'},
          draw: {
            text: {
              order: 8,
              text_source: 'name',
              font: {
                family: 'Montserrat',
                size: [
                  [6, '11px'],
                  [12, '14px']
                ],
                fill: '#4b4b4b',
                stroke: {color: '#f5f3ef', width: 3}
              }
            }
          }
        }
      }
    };
    if (!labels) {
      delete scene.layers.places;
    }
    return scene;
  }

  function createTronNextzenScene(runtimeApiKey) {
    return {
      import: ['https://www.nextzen.org/carto/tron-style/6/tron-style.zip'],
      global: {
        sdk_api_key: runtimeApiKey || '',
        sdk_animated: true
      }
    };
  }

  function createTronCartoScene({
    portable = false,
    labels = true,
    animateTraffic = true,
    pointProbe = false,
    lineProbe = false
  } = {}) {
    const scene = {
      import: ['https://www.nextzen.org/carto/tron-style/6/tron-style.zip'],
      fonts: {
        Montserrat: {url: resolveExampleAsset('../classic/fonts/montserrat.woff')}
      },
      global: {
        sdk_api_key: '',
        sdk_animated: true,
        sdk_building_extrude: true
      },
      scene: {
        animated: true,
        background: {color: '#08111f'}
      },
      styles: {
        'tron-portable-traffic': {
          base: 'lines',
          animated: animateTraffic,
          texcoords: true
        }
      },
      sources: {
        mapzen: {
          type: 'MVT',
          url: 'https://tiles-a.basemaps.cartocdn.com/vectortiles/carto.streets/v1/{z}/{x}/{y}.mvt',
          url_params: null,
          rasters: [],
          tile_size: 512,
          max_zoom: 14
        }
      },
      layers: {
        landuse: {
          data: {source: 'mapzen', layer: '__tilezen_layer_disabled__'}
        },
        water: {
          data: {source: 'mapzen', layer: '__tilezen_layer_disabled__'}
        },
        transit: {
          data: {source: 'mapzen', layer: '__tilezen_layer_disabled__'}
        },
        'tron-carto-landcover': {
          data: {source: 'mapzen', layer: 'landcover'},
          draw: {
            polygons: {order: 1, color: '#101d31'}
          }
        },
        'tron-carto-landuse': {
          data: {source: 'mapzen', layer: 'landuse'},
          draw: {
            polygons: {order: 2, color: '#1b2946'}
          }
        },
        'tron-carto-water': {
          data: {source: 'mapzen', layer: 'water'},
          draw: {
            polygons: {
              style: portable ? 'polygons' : 'water-later',
              order: 3,
              color: '#102b4c'
            }
          }
        },
        'tron-carto-waterways': {
          data: {source: 'mapzen', layer: 'waterway'},
          draw: {
            lines: {
              style: portable ? 'lines' : 'water-boundaries-animated',
              order: 4,
              color: '#178fdb',
              width: [
                [8, '0.5px'],
                [14, '2px'],
                [18, '5px']
              ]
            }
          }
        },
        'tron-carto-buildings': {
          data: {source: 'mapzen', layer: 'building'},
          filter: {$zoom: {min: 14}},
          draw: {
            polygons: {
              order: 5,
              color: '#14243c',
              extrude: true
            },
            lines: {
              order: 6,
              color: '#267f9e',
              width: '0.5px',
              extrude: true
            }
          }
        },
        'tron-carto-roads': {
          data: {source: 'mapzen', layer: 'transportation'},
          draw: {
            glow: {
              style: portable ? 'lines' : 'roads-glow',
              order: 7,
              color: '#0b6f8d',
              width: [
                [8, '0.75px'],
                [13, '2px'],
                [18, '7px']
              ]
            },
            centerline: {
              style: 'lines',
              order: 8,
              color: '#162c4c',
              width: [
                [8, '0.35px'],
                [13, '0.75px'],
                [18, '3px']
              ]
            }
          },
          major: {
            filter: {class: ['primary', 'secondary']},
            draw: {
              glow: {
                color: '#169fbd',
                width: [
                  [8, '1.5px'],
                  [13, '5px'],
                  [18, '18px']
                ]
              },
              centerline: {
                color: '#10223d',
                width: [
                  [8, '0.75px'],
                  [13, '3px'],
                  [18, '10px']
                ]
              }
            }
          },
          trunk: {
            filter: {class: 'trunk', $zoom: {min: 10}},
            draw: {
              traffic: {
                style: portable ? 'tron-portable-traffic' : 'fast-traffic-animation-twoways',
                order: 9,
                color: '#10223d',
                width: [
                  [10, '0.5px'],
                  [13, '3px'],
                  [18, '10px']
                ],
                outline: {color: '#4ee5e1', width: '0.5px'}
              }
            }
          },
          highway: {
            filter: {class: 'motorway', $zoom: {min: 10}},
            draw: {
              glow: {
                color: '#7a46c1',
                width: [
                  [10, '1.75px'],
                  [13, '6px'],
                  [18, '18px']
                ]
              },
              traffic: {
                style: portable ? 'tron-portable-traffic' : 'fast-traffic-animation-twoways',
                order: 9,
                color: '#15142f',
                width: [
                  [10, '0.4px'],
                  [13, '2.5px'],
                  [18, '8px']
                ],
                outline: {color: '#bd5be0', width: '0.55px'}
              }
            }
          }
        },
        'tron-carto-places': {
          data: {source: 'mapzen', layer: 'place'},
          draw: {
            text: {
              order: 10,
              text_source: 'name',
              font: {
                family: 'Montserrat',
                size: [
                  [6, '11px'],
                  [12, '13px'],
                  [16, '15px']
                ],
                fill: '#70f4ff',
                stroke: {color: '#08111f', width: 3}
              }
            }
          }
        }
      }
    };
    if (!labels) {
      delete scene.layers['tron-carto-places'];
    } else if (pointProbe) {
      scene.layers['tron-carto-places'].draw.points = {
        order: 11,
        color: '#ff4fd8',
        size: '12px',
        outline: {color: '#ffffff', width: '2px'},
        text: {
          anchor: 'top',
          text_source: 'name',
          font: {
            family: 'Montserrat',
            size: '9px',
            fill: '#ff9bea',
            stroke: {color: '#08111f', width: 2}
          }
        }
      };
      if (pointProbe === 'sprite') {
        scene.textures = {
          'point-probe': {url: resolveExampleAsset('../classic/images/wheel.png')}
        };
        scene.layers['tron-carto-places'].draw.points.texture = 'point-probe';
        scene.layers['tron-carto-places'].draw.points.color = '#ffffff';
        delete scene.layers['tron-carto-places'].draw.points.outline;
      }
    }
    if (lineProbe) {
      const line = {
        type: 'LineString',
        coordinates: [
          [-74.016, 40.707],
          [-74.003, 40.707]
        ]
      };
      const lineProbeData = {
        type: 'FeatureCollection',
        features: ['base', 'offset', 'elevated', 'dashed'].map((kind) => ({
          type: 'Feature',
          properties: {kind},
          geometry: line
        }))
      };
      scene.sources['line-probe'] = {
        type: 'GeoJSON',
        url:
          'data:application/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(lineProbeData))
      };
      scene.layers['line-probe'] = {
        data: {source: 'line-probe'},
        base: {
          filter: {kind: 'base'},
          draw: {
            lines: {order: 30, color: '#1af7ff', width: '3px'}
          }
        },
        offset: {
          filter: {kind: 'offset'},
          draw: {
            lines: {
              order: 31,
              color: '#ff4fd8',
              width: '2px',
              offset: '10px'
            }
          }
        },
        elevated: {
          filter: {kind: 'elevated'},
          draw: {
            lines: {
              order: 32,
              color: '#ff9d24',
              width: '2px',
              offset: '-10px',
              z: '60m'
            }
          }
        },
        dashed: {
          filter: {kind: 'dashed'},
          draw: {
            lines: {
              order: 33,
              color: '#a8ff42',
              width: '4px',
              offset: '-26px',
              dash: [4, 2],
              dash_background_color: '#18304a'
            }
          }
        }
      };
    }
    return scene;
  }

  window.tangramDeckExampleDestroy = function destroyTangramDeckExample() {
    document.removeEventListener('fullscreenchange', updateFullscreenButton);
    if (deckInstance) {
      deckInstance.finalize();
      deckInstance = null;
    }
  };
}
