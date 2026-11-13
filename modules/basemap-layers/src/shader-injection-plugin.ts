// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {ShaderModule, ShaderPlugin} from '@luma.gl/shaders';

/** Separates a GLSL extension's ordered hook contributions from its uniform module. */
export function createShaderInjectionPlugin(
  definition: ShaderModule & {inject: Record<string, string | {injection: string; order?: number}>}
): ShaderPlugin {
  const {inject, ...module} = definition;
  return {
    name: module.name,
    module,
    injections: Object.entries(inject).map(([key, value]) => {
      const separator = key.indexOf(':');
      return {
        stage: key.startsWith('vs:') ? 'vertex' : 'fragment',
        target: key.slice(separator + 1),
        glsl: typeof value === 'string' ? value : value.injection,
        order: typeof value === 'string' ? undefined : value.order
      };
    })
  };
}
