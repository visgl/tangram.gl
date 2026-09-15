// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/** Submit each WebGPU eye before Tangram reuses its mutable uniform buffers for the next eye. */
export function submitEyeRenderPass(device, renderPass) {
  renderPass.end();
  // Buffer.write uses GPUQueue.writeBuffer, not a command encoded between draws.
  // Deferring both eyes to the animation loop's final submit makes the first eye
  // see the second eye's projection and per-mesh model-view matrices. Submitting
  // here orders the first eye's draws before the next eye's buffer writes.
  // No CPU/GPU wait is needed. WebGL executes these state changes immediately.
  if (device.type === 'webgpu') {
    device.submit();
  }
}
