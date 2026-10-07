// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

const sidebars = {
  examplesSidebar: [
    {
      type: 'doc',
      id: 'index',
      label: 'Examples'
    },
    {
      type: 'category',
      label: '@vis.gl/tangram-layers',
      collapsed: false,
      items: [
        {type: 'doc', id: 'deck', label: 'MapView perspective'},
        {type: 'doc', id: 'deck-map-flat', label: 'MapView flat'},
        {type: 'doc', id: 'deck-globe', label: 'GlobeView'},
        {type: 'doc', id: 'deck-first-person', label: 'FirstPersonView'},
        {type: 'doc', id: 'deck-projected', label: 'Projected basemaps (experimental)'}
      ]
    },
    {
      type: 'category',
      label: '@vis.gl/tangram-layers (WebXR)',
      collapsed: false,
      items: [
        {type: 'doc', id: 'webxr', label: 'GlobeView'},
        {type: 'doc', id: 'webxr-map-view', label: 'MapView'},
        {type: 'doc', id: 'webxr-first-person', label: 'FirstPersonView'},
        {type: 'doc', id: 'webxr-thor', label: 'Thor gestures'}
      ]
    },
    {
      type: 'category',
      label: '@vis.gl/tangram-renderer',
      collapsed: false,
      items: [
        {type: 'doc', id: 'classic', label: 'Classic playground'},
        {type: 'doc', id: 'leaflet', label: 'Leaflet integration'}
      ]
    }
  ]
};

module.exports = sidebars;
