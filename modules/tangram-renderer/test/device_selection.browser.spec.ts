// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test, vi} from 'vitest';
import type {Device} from '@luma.gl/core';
import {Texture} from '@luma.gl/core';
import FeatureSelection from '../src/selection/selection';
import Scene from '../src/scene/classic_scene';

test('device selection owns and releases its framebuffer without raw texture attachment', () => {
  const framebuffer = {get handle() { throw new Error('Raw handle accessed'); }, destroy: vi.fn()};
  const createFramebuffer = vi.fn(() => framebuffer);
  const texture = {destroy: vi.fn()};
  const createTexture = vi.fn(() => texture);
  const device = {createFramebuffer, createTexture} as unknown as Device;
  const gl = {FRAMEBUFFER: 0, createFramebuffer: vi.fn(), framebufferTexture2D: vi.fn(),
    deleteFramebuffer: vi.fn(), bindFramebuffer: vi.fn(), viewport: vi.fn(), clearColor: vi.fn()};
  const selection = new FeatureSelection(gl as unknown as WebGLRenderingContext, [], () => false, device);
  expect(createFramebuffer).toHaveBeenCalledWith({
    id: 'tangram-selection', width: 256, height: 256,
    colorAttachments: [texture], depthStencilAttachment: 'depth16unorm'
  });
  expect(createTexture).toHaveBeenCalledWith({id: 'tangram-selection-color', width: 256, height: 256,
    format: 'rgba8unorm', usage: Texture.RENDER_ATTACHMENT | Texture.COPY_SRC});
  expect(() => selection.bind()).toThrow('Device selection must use a luma render pass');
  expect(gl.bindFramebuffer).not.toHaveBeenCalled();
  expect(gl.createFramebuffer).not.toHaveBeenCalled();
  expect(gl.framebufferTexture2D).not.toHaveBeenCalled();
  selection.destroy();
  selection.destroy();
  expect(framebuffer.destroy).toHaveBeenCalledTimes(1);
  expect(texture.destroy).toHaveBeenCalledTimes(1);
  expect(gl.deleteFramebuffer).not.toHaveBeenCalled();
});

test('failed selection framebuffer creation releases its supplied texture', () => {
  const texture = {destroy: vi.fn()};
  const device = {createTexture: () => texture, createFramebuffer: () => { throw new Error('attachment failed'); }};
  expect(() => new FeatureSelection(null, [], undefined, device as unknown as Device)).toThrow('attachment failed');
  expect(texture.destroy).toHaveBeenCalledTimes(1);
});

test.each([
  {type: 'webgl', throws: false}, {type: 'webgl', throws: true},
  {type: 'webgpu', throws: false}, {type: 'webgpu', throws: true}
])('$type: selection ends its pass even when drawing fails: $throws', ({type, throws}) => {
  const renderPass = {end: vi.fn()};
  const commands = {};
  const encoder = {beginRenderPass: vi.fn(() => renderPass), finish: vi.fn(() => commands), destroy: vi.fn()};
  const renderSelection = vi.fn(() => {
    if (throws) throw new Error('selection draw failed');
  });
  const scene = {
    gl: {bindFramebuffer: vi.fn(), viewport: vi.fn(), clearColor: vi.fn()},
    device: {type, beginRenderPass: vi.fn(() => renderPass), createCommandEncoder: vi.fn(() => encoder), submit: vi.fn()},
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
  expect(type === 'webgpu' ? encoder.beginRenderPass : scene.device.beginRenderPass).toHaveBeenCalledWith({
    framebuffer: scene.selection.framebuffer, clearColor: [0, 0, 0, 1], clearDepth: 1
  });
  expect(renderSelection).toHaveBeenCalledWith('selection_program', {allow_blend: false, renderPass});
  expect(renderPass.end).toHaveBeenCalledTimes(1);
  if (type === 'webgpu') {
    expect(scene.device.beginRenderPass).not.toHaveBeenCalled();
    expect(scene.device.submit).toHaveBeenCalledWith(commands);
    expect(encoder.destroy).not.toHaveBeenCalled(); // finish owns disposal.
    expect(renderPass.end.mock.invocationCallOrder[0]).toBeLessThan(encoder.finish.mock.invocationCallOrder[0]);
  }
  expect(scene.gl.bindFramebuffer).not.toHaveBeenCalled();
  expect(scene.gl.viewport).not.toHaveBeenCalled();
  expect(scene.gl.clearColor).not.toHaveBeenCalled();
});

test.each(['begin', 'end', 'finish'])('selection encoder is released when %s fails', phase => {
  const pass = {end: vi.fn(() => {if (phase === 'end') throw new Error('end');})};
  const encoder = {beginRenderPass: vi.fn(() => {if (phase === 'begin') throw new Error('begin'); return pass;}),
    finish: vi.fn(() => {if (phase === 'finish') throw new Error('finish'); return {};}), destroy: vi.fn()};
  const scene = {device: {type: 'webgpu', createCommandEncoder: () => encoder, submit: vi.fn()},
    selection: {framebuffer: {}, locked: false, read: vi.fn()}, lights: {},
    view: {panning: false, user_input_active: false}, frame: 2, last_selection_render: 0, last_main_render: 1,
    updateBackground: vi.fn(), renderPass: vi.fn()};
  expect(() => Scene.prototype.render.call(scene, {main: false, selection: true})).toThrow(phase);
  expect(encoder.destroy).toHaveBeenCalledOnce();
  expect(scene.device.submit).not.toHaveBeenCalled();
});
