// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/** Lossless, asymmetric 4×4 Terrarium image; independent of live tile services. */
export async function createTerrainFixture(heightScale = 1): Promise<{bytes: ArrayBuffer; pixels: Uint8ClampedArray}> {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 4;
    const context = canvas.getContext('2d')!;
    const image = context.createImageData(4, 4);
    for (let row = 0; row < 4; row++) for (let column = 0; column < 4; column++) {
        const elevation = 800 + column * 100 + row * 200 + (column === 2 && row === 2 ? 1000 : 0);
        const packed = (elevation + 0.25) * heightScale + 32768;
        image.data.set([Math.floor(packed / 256), Math.floor(packed) % 256, Math.round((packed % 1) * 256), 255], (row * 4 + column) * 4);
    }
    context.putImageData(image, 0, 0);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(result => result ? resolve(result) : reject(new Error('PNG encoding failed')), 'image/png'));
    return {bytes: await blob.arrayBuffer(), pixels: image.data};
}
