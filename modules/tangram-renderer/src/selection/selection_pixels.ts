// Tangram
// SPDX-License-Identifier: MIT
// Copyright (c) 2013-2016 Brett Camper and Mapzen
// Copyright (c) 2026 vis.gl contributors

import type {Device, Texture} from '@luma.gl/core';
import {readDevicePixels} from '../gpu/pixel_readback';

/** Read a selection rectangle with transparent padding where it crosses texture edges. */
export async function readSelectionPixels(device: Device, texture: Texture,
    point: {x: number; y: number}, radius?: {x: number; y: number} | null): Promise<{pixels: Uint8Array; width: number; height: number}> {
    if (![point.x, point.y, radius?.x ?? 0, radius?.y ?? 0].every(Number.isFinite) ||
        (radius && (radius.x < 0 || radius.y < 0))) {
        throw new Error('Selection point and radius must be finite, with a non-negative radius');
    }
    const maximum = Math.min(texture.width, texture.height);
    const width = radius ? Math.min(Math.ceil(radius.x * 2 * texture.width), maximum) : 1;
    const height = radius ? Math.min(Math.ceil(radius.y * 2 * texture.height), maximum) : 1;
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 0 || height < 0) {
        throw new Error('Selection radius must produce finite non-negative pixel dimensions');
    }
    const pixels = new Uint8Array(width * height * 4);
    // Selection's WebGL target has bottom-origin rows. WebGPU selection shaders
    // are not enabled yet; this does not claim a portable picking convention.
    const x = Math.round((point.x - (radius?.x || 0)) * texture.width);
    const y = Math.round((1 - point.y - (radius?.y || 0)) * texture.height);
    const sourceX = Math.max(0, x), sourceY = Math.max(0, y);
    const clippedWidth = Math.min(texture.width, x + width) - sourceX;
    const clippedHeight = Math.min(texture.height, y + height) - sourceY;
    if (clippedWidth > 0 && clippedHeight > 0) {
        const data = await readDevicePixels(device, texture, {x: sourceX, y: sourceY, width: clippedWidth, height: clippedHeight});
        for (let row = 0; row < clippedHeight; row++) {
            pixels.set(data.subarray(row * clippedWidth * 4, (row + 1) * clippedWidth * 4),
                ((sourceY - y + row) * width + sourceX - x) * 4);
        }
    }
    return {pixels, width, height};
}

/** Decode the existing RGB feature/alpha worker key, preferring the center then the nearest hit. */
export function findSelectionKey(pixels: Uint8Array, width: number, height: number): {key: number; workerId: number} | null {
    if (width <= 0 || height <= 0) return null;
    const center = (Math.min(height - 1, Math.round(height / 2)) * width + Math.min(width - 1, Math.round(width / 2))) * 4;
    const decode = (offset: number) => {
        const feature = pixels[offset] + (pixels[offset + 1] << 8) + (pixels[offset + 2] << 16);
        return feature > 0 ? {key: (feature + (pixels[offset + 3] << 24)) >>> 0, workerId: pixels[offset + 3]} : null;
    };
    const centerHit = decode(center);
    if (centerHit) return centerHit;
    let nearest = null;
    let minimumDistance = Infinity;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const hit = decode((y * width + x) * 4);
            const distance = (x - width / 2) ** 2 + (y - height / 2) ** 2;
            if (hit && distance <= minimumDistance) { nearest = hit; minimumDistance = distance; }
        }
    }
    return nearest;
}
