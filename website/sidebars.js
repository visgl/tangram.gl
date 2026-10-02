// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

module.exports = {
  docsSidebar: [
    {
      type: 'category',
      label: 'Overview',
      items: [
        {type: 'doc', id: 'README', label: 'Overview'},
        {type: 'doc', id: 'whats-new', label: "What's new"},
        {type: 'doc', id: 'upgrade-guide', label: 'Upgrade guide'}
      ]
    },
    {
      type: 'category',
      label: 'Developer guide',
      items: [
        'get-started/getting-started',
        'developer-guide/architecture',
        'developer-guide/view-integration',
        'developer-guide/visgl-conformance',
        'developer-guide/tile-providers',
        'developer-guide/bundling',
        {type: 'doc', id: 'developer-guide/legacy-concepts', label: 'Tangram concepts'}
      ]
    },
    {
      type: 'category',
      label: 'Contributor guide',
      items: [
        'contributor-guide/development',
        'contributor-guide/monorepo',
        'contributor-guide/licensing',
        'contributor-guide/release'
      ]
    },
    {
      type: 'category',
      label: 'API reference',
      items: [
        {
          type: 'category',
          label: '@vis.gl/tangram-renderer',
          items: [
            {
              type: 'doc',
              id: 'api-reference/tangram-renderer',
              label: 'Package overview'
            },
            {type: 'doc', id: 'api-reference/classic-api', label: 'Classic Tangram API'},
            {type: 'doc', id: 'api-reference/scene', label: 'Scene API'},
            {type: 'doc', id: 'api-reference/renderer', label: 'Renderer API'},
            {type: 'doc', id: 'api-reference/host-frame', label: 'HostFrame API'},
            {type: 'doc', id: 'api-reference/styling', label: 'Styling reference'}
          ]
        },
        {
          type: 'category',
          label: '@vis.gl/tangram-layers',
          items: [
            {
              type: 'doc',
              id: 'api-reference/tangram-layers',
              label: 'Package overview'
            },
            {type: 'doc', id: 'api-reference/tangram-layer', label: 'TangramLayer API'},
            {
              type: 'doc',
              id: 'api-reference/webxr-presentation',
              label: 'Experimental WebXR API'
            }
          ]
        }
      ]
    }
  ]
};
