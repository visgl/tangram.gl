// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

// @ts-check

const path = require('path');

/** @type {import('@docusaurus/types').Config} */
const config = {
  title: 'tangram.gl',
  tagline: 'Tangram rendering and deck.gl basemap integration',
  url: 'https://vis.gl',
  baseUrl: '/tangram.gl/',
  favicon: '/favicon.png',
  organizationName: 'visgl',
  projectName: 'tangram.gl',
  onBrokenLinks: 'warn',
  headTags: [
    {
      tagName: 'meta',
      attributes: {
        name: 'robots',
        content: 'noindex, nofollow, noarchive'
      }
    }
  ],
  markdown: {
    hooks: {
      onBrokenMarkdownLinks: 'warn'
    }
  },
  trailingSlash: false,
  future: {
    v4: true,
    faster: true
  },

  presets: [
    [
      'classic',
      {
        docs: {
          path: path.resolve(__dirname, '../docs'),
          routeBasePath: 'docs',
          sidebarPath: path.resolve(__dirname, 'sidebars.js'),
          editUrl: 'https://github.com/visgl/tangram.gl/tree/master/'
        },
        blog: false,
        theme: {
          customCss: path.resolve(__dirname, 'src/css/custom.css')
        }
      }
    ]
  ],

  plugins: [
    [
      '@signalwire/docusaurus-plugin-llms-txt',
      {
        siteTitle: 'tangram.gl',
        siteDescription: 'Experimental Tangram scene rendering, styling and deck.gl basemap integration on WebGPU and WebGL 2.',
        // Plugin 1.x includes the deployment subpath in its hierarchy and URLs.
        // The post-build step normalizes that prefix and validates all outputs.
        depth: 4,
        enableDescriptions: true,
        includeOrder: [
          '/tangram.gl/docs',
          '/tangram.gl/docs/get-started/**',
          '/tangram.gl/docs/api-reference/**',
          '/tangram.gl/docs/developer-guide/**',
          '/tangram.gl/docs/contributor-guide/**'
        ],
        onRouteError: 'throw',
        content: {
          enableMarkdownFiles: true,
          enableLlmsFullTxt: false,
          relativePaths: false,
          includeBlog: false,
          includePages: false,
          includeDocs: true,
          includeVersionedDocs: false,
          includeGeneratedIndex: true,
          excludeRoutes: ['/tangram.gl/examples/**', '/tangram.gl/docs/examples/**']
        }
      }
    ],
    [
      '@docusaurus/plugin-content-docs',
      {
        id: 'examples',
        path: path.resolve(__dirname, 'src/examples'),
        routeBasePath: 'examples',
        sidebarPath: path.resolve(__dirname, 'src/examples-sidebar.js'),
        breadcrumbs: true,
        showLastUpdateTime: false,
        showLastUpdateAuthor: false
      }
    ]
  ],

  themeConfig: {
    navbar: {
      title: 'tangram.gl',
      items: [
        {to: '/docs', label: 'Docs', position: 'left'},
        {
          to: '/examples',
          label: 'Examples',
          position: 'left'
        },
        {
          href: 'https://github.com/visgl/tangram.gl',
          label: 'GitHub',
          position: 'right'
        }
      ]
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: 'Resources',
          items: [
            {label: 'Documentation', to: '/docs'},
            {label: 'Deck example', href: '/tangram.gl/examples/deck'}
          ]
        },
        {
          title: 'Project',
          items: [
            {label: 'GitHub', href: 'https://github.com/visgl/tangram.gl'},
            {label: 'Original Tangram repository', href: 'https://github.com/tangrams/tangram'},
            {label: 'Mapzen organization', href: 'https://github.com/mapzen'},
            {label: 'vis.gl', href: 'https://vis.gl/'}
          ]
        }
      ],
      copyright: `Copyright © ${new Date().getFullYear()} Tangram contributors`
    }
  }
};

module.exports = config;
