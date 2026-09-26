// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test, vi} from 'vitest';
import type {Device} from '@luma.gl/core';
import FeatureSelection from '../src/selection/selection';
import Scene from '../src/scene/scene';

test('device selection owns and releases its framebuffer without raw texture attachment', () => {
  const framebuffer = {handle: {}, destroy: vi.fn()};
  const createFramebuffer = vi.fn(() => framebuffer);
  const device = {createFramebuffer} as unknown as Device;
  const gl = {FRAMEBUFFER: 0, createFramebuffer: vi.fn(), framebufferTexture2D: vi.fn(),
    deleteFramebuffer: vi.fn(), bindFramebuffer: vi.fn(), viewport: vi.fn(), clearColor: vi.fn()};
  const selection = new FeatureSelection(gl, [], () => false, device);
  expect(createFramebuffer).toHaveBeenCalledWith({
    id: 'tangram-selection', width: 256, height: 256,
    colorAttachments: ['rgba8unorm'], depthStencilAttachment: 'depth16unorm'
  });
  selection.bind();
  expect(gl.bindFramebuffer).toHaveBeenCalledWith(gl.FRAMEBUFFER, framebuffer.handle);
  expect(gl.createFramebuffer).not.toHaveBeenCalled();
  expect(gl.framebufferTexture2D).not.toHaveBeenCalled();
  selection.destroy();
  selection.destroy();
  expect(framebuffer.destroy).toHaveBeenCalledTimes(1);
  expect(gl.deleteFramebuffer).not.toHaveBeenCalled();
});

test.each([false, true])('selection ends its device pass even when drawing fails: %s', throws => {
  const renderPass = {end: vi.fn()};
  const renderSelection = vi.fn(() => {
    if (throws) throw new Error('selection draw failed');
  });
  const scene = {
    gl: {bindFramebuffer: vi.fn(), viewport: vi.fn(), clearColor: vi.fn()},
    device: {beginRenderPass: vi.fn(() => renderPass)},
    selection: {framebuffer: {}, locked: false, read: vi.fn()},
    view: {panning: false, user_input_active: false},
    lights: {}, canvas: {width: 512, height: 320},
    background: {computed_color: [0, 0, 0, 1]},
    frame: 2, last_selection_render: 0, last_main_render: 1,
    updateBackground: vi.fn(), renderPass: renderSelection
  };
  const draw = () => Scene.prototype.render.call(scene, {main: false, selection: true});
  if (throws) expect(draw).toThrow('selection draw failed');
  else {
    draw();
    expect(scene.selection.read).toHaveBeenCalledTimes(1);
  }
  expect(scene.device.beginRenderPass).toHaveBeenCalledWith({
    framebuffer: scene.selection.framebuffer, clearColor: [0, 0, 0, 1], clearDepth: 1
  });
  expect(renderSelection).toHaveBeenCalledWith('selection_program', {allow_blend: false, renderPass});
  expect(renderPass.end).toHaveBeenCalledTimes(1);
});
