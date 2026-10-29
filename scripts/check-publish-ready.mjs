// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {readFileSync} from 'node:fs';

const version = process.env.RELEASE_VERSION;
const packages = ['tangram-renderer', 'tangram-layers', 'basemap-layers'];
if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error('RELEASE_VERSION must be an exact npm version.');
}
for (const packageName of packages) {
  const manifest = JSON.parse(readFileSync(`modules/${packageName}/package.json`, 'utf8'));
  if (manifest.name !== `@tangram.gl/${packageName}` || manifest.version !== version) {
    throw new Error(`${packageName}: package name or version does not match the release.`);
  }
  if (manifest.private !== false) {
    throw new Error(`${packageName}: publishing is disabled until private is explicitly set to false.`);
  }
}
