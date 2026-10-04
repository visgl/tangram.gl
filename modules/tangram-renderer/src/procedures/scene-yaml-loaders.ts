// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {YAMLLoaderWithParser} from '@loaders.gl/config/yaml-loader';

/** Parse a Tangram scene with the candidate loaders.gl YAML implementation. */
export function parseSceneYamlWithLoaders(source: string): unknown {
  return YAMLLoaderWithParser.parseTextSync(source, {yaml: {uniqueKeys: false}});
}
