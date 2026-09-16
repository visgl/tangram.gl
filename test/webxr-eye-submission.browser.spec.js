// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {describe, expect, it, vi} from 'vitest';
import {submitEyeRenderPass} from '../examples/webxr/submit-eye.js';

describe('WebXR eye submission', () => {
  it('submits each eye before shared camera and mesh buffers are overwritten', () => {
    const sharedUniforms = {projection: 0, modelView: 0};
    const encodedDraws = [];
    const renderedEyes = [];
    const device = {
      type: 'webgpu',
      submit() {
        // Like WebGPU, an encoded draw references a buffer, not a copy of its data.
        for (const buffers of encodedDraws.splice(0)) renderedEyes.push({...buffers});
      }
    };
    for (const eye of [-1, 1]) {
      sharedUniforms.projection = eye * 0.1;
      sharedUniforms.modelView = eye * 0.032;
      const renderPass = {end: vi.fn(() => encodedDraws.push(sharedUniforms))};
      submitEyeRenderPass(device, renderPass);
      expect(renderPass.end).toHaveBeenCalledOnce();
    }
    expect(renderedEyes).toEqual([
      {projection: -0.1, modelView: -0.032},
      {projection: 0.1, modelView: 0.032}
    ]);
  });

  it('does not add submissions to the immediate WebGL path', () => {
    const device = {type: 'webgl', submit: vi.fn()};
    const renderPass = {end: vi.fn()};
    submitEyeRenderPass(device, renderPass);
    expect(renderPass.end).toHaveBeenCalledOnce();
    expect(device.submit).not.toHaveBeenCalled();
  });
});
