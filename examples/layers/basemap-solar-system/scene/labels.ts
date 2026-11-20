// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/**
 * Font props of the example's TextLayers: SDF glyphs with a black outline.
 *
 * The glyph atlas is drawn at 64 px and the labels at 11 to 13 px. deck.gl samples the atlas with
 * mipmaps by default. A mipmap level averages the distance field across a thin stroke (an "I", a
 * "."), so the averaged distance falls below the SDF edge and the glyph is not drawn. Which glyph
 * disappears depends on its sub-pixel position. Without mipmaps, bilinear samples of the distance
 * field stay correct at any scale, which is the reason to use a distance field.
 */
export const LABEL_FONT = {
  fontFamily: 'system-ui, sans-serif',
  outlineWidth: 2,
  outlineColor: [0, 0, 0, 255] as [number, number, number, number],
  fontSettings: {sdf: true},
  _subLayerProps: {
    characters: {
      textureParameters: {
        minFilter: 'linear',
        magFilter: 'linear',
        mipmapFilter: 'none',
        addressModeU: 'clamp-to-edge',
        addressModeV: 'clamp-to-edge'
      }
    }
  }
} as const;
