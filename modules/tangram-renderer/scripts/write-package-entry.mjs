// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {mkdir, writeFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = resolve(packageDirectory, 'dist/index.js');
const packageEntry = `// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import Tangram, {calculatePlanarGroundBounds, WebMercatorGlobeVisibilityAdapter, WebMercatorVisibilityAdapter} from './tangram.debug.mjs';

const {Scene, ClassicWebGLRenderer, HostFrame, LumaDeviceRenderer, debug, version} =
  Tangram;
const Renderer = ClassicWebGLRenderer;

export {
  Scene,
  ClassicWebGLRenderer,
  Renderer,
  HostFrame,
  LumaDeviceRenderer,
  debug,
  version,
  calculatePlanarGroundBounds,
  WebMercatorGlobeVisibilityAdapter,
  WebMercatorVisibilityAdapter
};
export default Tangram;
`;

await mkdir(dirname(outputPath), {recursive: true});
await writeFile(outputPath, packageEntry);
