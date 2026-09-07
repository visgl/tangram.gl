// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

// @ts-check

const path = require('path');

/** @type {import('@docusaurus/types').Config} */
const config = {
  title: 'tangram.gl',
  tagline: 'Tangram rendering and deck.gl basemap integration',
  url: 'https://visgl.github.io',
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
