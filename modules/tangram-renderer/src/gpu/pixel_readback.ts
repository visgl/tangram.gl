// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {Buffer} from '@luma.gl/core';
import type {CommandEncoder, Device, Texture} from '@luma.gl/core';

/** A mip-zero rectangle in the texture's native texel coordinate system. */
export type PixelReadRectangle = {x: number; y: number; width: number; height: number};

/**
 * Read tightly packed RGBA8 bytes through public luma core commands.
 * WebGPU row padding is removed; row orientation stays native to the backend.
 * The caller owns the COPY_SRC-capable texture/device. This call owns and releases its
 * staging buffer, including when encoding, submission or mapping fails.
 * WebGL's readAsync implementation may still synchronize with the GPU.
 */
export async function readDevicePixels(device: Device, texture: Texture, rectangle: PixelReadRectangle): Promise<Uint8Array> {
    const {x, y, width, height} = rectangle;
    if (texture.format !== 'rgba8unorm' || texture.dimension !== '2d' || texture.samples !== 1) {
        throw new Error('Pixel readback requires a single-sample rgba8unorm 2D texture');
    }
    if (![x, y, width, height].every(Number.isSafeInteger) || x < 0 || y < 0 || width <= 0 || height <= 0 ||
        x + width > texture.width || y + height > texture.height) {
        throw new Error('Pixel readback rectangle must be positive and inside the texture');
    }
    const rowBytes = width * 4;
    const bytesPerRow = device.type === 'webgpu' ? Math.ceil(rowBytes / 256) * 256 : rowBytes;
    const staging = device.createBuffer({id: 'tangram-pixel-readback',
        byteLength: bytesPerRow * height, usage: Buffer.COPY_DST | Buffer.MAP_READ});
    let encoder: CommandEncoder | undefined;
    try {
        encoder = device.createCommandEncoder({id: 'tangram-pixel-readback'});
        encoder.copyTextureToBuffer({sourceTexture: texture, destinationBuffer: staging,
            origin: [x, y, 0], width, height,
            ...(device.type === 'webgpu' ? {bytesPerRow, rowsPerImage: height} : {})});
        const commands = encoder.finish(); // finish releases the encoder; submit releases the command buffer.
        encoder = undefined;
        device.submit(commands);
        const padded = await staging.readAsync();
        if (padded.byteLength < bytesPerRow * height) throw new Error('Pixel readback returned incomplete data');
        const pixels = new Uint8Array(rowBytes * height);
        for (let row = 0; row < height; row++) {
            pixels.set(padded.subarray(row * bytesPerRow, row * bytesPerRow + rowBytes), row * rowBytes);
        }
        return pixels;
    } finally {
        encoder?.destroy();
        staging.destroy();
    }
}
