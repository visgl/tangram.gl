// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {getSidebarMarkdownPaths, prepareLlmOutput} from './llm-output.mjs';

const require = createRequire(import.meta.url);
const config = require('../docusaurus.config.js');
const sidebar = require('../sidebars.js');
const buildDirectory = fileURLToPath(new URL('../build/', import.meta.url));
const pages = prepareLlmOutput(buildDirectory, config, getSidebarMarkdownPaths(sidebar.docsSidebar));
console.log(`Validated llms.txt and ${pages} rendered Markdown documentation pages.`);
