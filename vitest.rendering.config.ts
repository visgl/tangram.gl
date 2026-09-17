// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {getVitestConfig} from '@vis.gl/dev-tools';
import {startRenderingDiagnostics, renderingDiagnostics, dragRenderingCanvas, panRenderingCanvas,
  pinchRenderingCanvas, saveRenderingArtifact} from './test/rendering/commands.ts';

const device = process.env.TANGRAM_TEST_DEVICE || 'webgl';
if (!['webgl', 'webgpu'].includes(device)) {
  throw new Error('TANGRAM_TEST_DEVICE must be webgl or webgpu');
}

export default getVitestConfig({
  launchOptions: {
    // Use the same Chromium software pipeline as luma.gl's render tests. The
    // Vulkan compositor and Xvfb display are required for WebGPU canvas capture;
    // the ANGLE flags remain enabled so the WebGL lane stays pixel-stable.
    args: [
      '--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--enable-gpu',
      '--enable-features=Vulkan', '--use-vulkan=swiftshader',
      '--enable-unsafe-swiftshader', '--use-angle=swiftshader'
    ]
  },
  overrides: {
    define: {__TEST_DEVICE__: JSON.stringify(device)},
    // Exercise published bundles (including the inlined scene worker).
    optimizeDeps: {
      include: ['@deck.gl/core', '@luma.gl/core', '@luma.gl/engine', '@luma.gl/webgl', '@luma.gl/webgpu',
        '@luma.gl/experimental', '@math.gl/core', 'mjolnir.js'],
      exclude: ['@vis.gl/tangram-renderer', '@vis.gl/tangram-layers']
    }
  },
  projects: {
    node: false,
    browser: false,
    headless: {
      test: {
        include: ['test/rendering/**/*.render.spec.ts'],
        fileParallelism: false,
        testTimeout: 45000,
        hookTimeout: 45000,
        browser: {
          viewport: {width: 900, height: 650},
          screenshotDirectory: `screenshots/rendering/${device}`,
          commands: {startRenderingDiagnostics, renderingDiagnostics, dragRenderingCanvas, panRenderingCanvas,
            pinchRenderingCanvas, saveRenderingArtifact}
        }
      }
    }
  }
});
