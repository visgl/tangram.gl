// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/**
 * `icon-text-fit`: an icon stretched to cover its label, and the stretchable images that sprites
 * describe with `stretchX`, `stretchY` and `content`, laid out as MapLibre GL JS lays them out
 * (`fitIconToText` and `applyTextFit` in its `symbol/shaping.ts`, `getIconQuads` in
 * `symbol/quads.ts`). Boxes are in CSS pixels from the symbol's anchor, y down.
 */

/** `icon-text-fit`: which sides of the label the icon is stretched to. */
export type IconTextFit = 'none' | 'width' | 'height' | 'both';

/** `textFitWidth` / `textFitHeight` of a sprite image. */
export type ImageTextFit = 'stretchOrShrink' | 'stretchOnly' | 'proportional';

/** A box in pixels from the symbol's anchor, y down. */
export type SymbolBox = {left: number; top: number; right: number; bottom: number};

/**
 * The size and stretch metadata of a sprite image, as its JSON index gives them: sizes and zones
 * in image pixels, which are `pixelRatio` per CSS pixel.
 */
export type StretchableImage = {
  width: number;
  height: number;
  pixelRatio: number;
  /** Ranges `[x1, x2]` of image columns that stretch. */
  stretchX?: [number, number][];
  /** Ranges `[y1, y2]` of image rows that stretch. */
  stretchY?: [number, number][];
  /** `[x1, y1, x2, y2]`: the part of the image that the label covers. */
  content?: [number, number, number, number];
  textFitWidth?: ImageTextFit;
  textFitHeight?: ImageTextFit;
};

/** An icon box fitted to its label, and how much of the image lies outside it (see `content`). */
export type FittedIcon = SymbolBox & {
  /** CSS pixels of the image outside `content`: left, top, right, bottom. */
  collisionPadding?: [number, number, number, number];
};

/**
 * One rectangle of a stretched icon, drawn from one part of its image. Its corners are
 * `em * max(minScale, iconSize) + px` (see {@link getIconQuadBox}): the `em` part stretches with
 * the label and scales with `icon-size`, the `px` part keeps the fixed zones at their size.
 */
export type IconQuad = {
  /** The part of the image, in image pixels from its top left corner. */
  image: {x: number; y: number; width: number; height: number};
  em: SymbolBox;
  px: SymbolBox;
  /** The least scale of `em` on each axis, so that the stretched zones never shrink below zero. */
  minScale: [number, number];
};

/**
 * MapLibre's `fitIconToText`: the box of an icon stretched to the box of its label, padded by
 * `icon-text-fit-padding` (`[top, right, bottom, left]`), and moved by `icon-offset`. On an axis it
 * is not stretched along, the icon keeps its size, centered on the label. `icon-anchor` is not
 * read. The box is at `icon-size` 1; {@link getIconQuads} and {@link getFittedIconCollisionBox}
 * scale it.
 */
export function fitIconToText(
  image: StretchableImage,
  text: SymbolBox,
  textFit: IconTextFit,
  padding: readonly number[],
  iconOffset: readonly number[]
): FittedIcon {
  const width = image.width / image.pixelRatio;
  const height = image.height / image.pixelRatio;
  const [padTop, padRight, padBottom, padLeft] = padding;
  const [offsetX, offsetY] = iconOffset;
  let left: number;
  let right: number;
  if (textFit === 'width' || textFit === 'both') {
    left = offsetX + text.left - padLeft;
    right = offsetX + text.right + padRight;
  } else {
    left = offsetX + (text.left + text.right - width) / 2;
    right = left + width;
  }
  let top: number;
  let bottom: number;
  if (textFit === 'height' || textFit === 'both') {
    top = offsetY + text.top - padTop;
    bottom = offsetY + text.bottom + padBottom;
  } else {
    top = offsetY + (text.top + text.bottom - height) / 2;
    bottom = top + height;
  }
  const {content, pixelRatio} = image;
  const collisionPadding: FittedIcon['collisionPadding'] = content
    ? [
        content[0] / pixelRatio,
        content[1] / pixelRatio,
        width - content[2] / pixelRatio,
        height - content[3] / pixelRatio
      ]
    : undefined;
  return {left, top, right, bottom, collisionPadding};
}

/**
 * MapLibre's `applyTextFit`: a fitted icon box widened or heightened to keep the aspect ratio of
 * its image's `content`, as the image's `textFitWidth` / `textFitHeight` ask. Only for images with
 * `content` and one of them.
 */
export function applyTextFit(image: StretchableImage, icon: SymbolBox): SymbolBox {
  let {left, top} = icon;
  let width = icon.right - left;
  let height = icon.bottom - top;
  const content = image.content!;
  const contentAspectRatio = (content[2] - content[0]) / (content[3] - content[1]);
  const textFitWidth = image.textFitWidth ?? 'stretchOrShrink';
  const textFitHeight = image.textFitHeight ?? 'stretchOrShrink';
  // Height wins when both axes are proportional.
  if (textFitHeight === 'proportional') {
    if (
      (textFitWidth === 'stretchOnly' && width / height < contentAspectRatio) ||
      textFitWidth === 'proportional'
    ) {
      const newWidth = Math.ceil(height * contentAspectRatio);
      left *= newWidth / width;
      width = newWidth;
    }
  } else if (textFitWidth === 'proportional') {
    if (
      textFitHeight === 'stretchOnly' &&
      contentAspectRatio !== 0 &&
      width / height > contentAspectRatio
    ) {
      const newHeight = Math.ceil(width / contentAspectRatio);
      top *= newHeight / height;
      height = newHeight;
    }
  }
  return {left, top, right: left + width, bottom: top + height};
}

/** Whether an image's `textFitWidth` / `textFitHeight` change its fitted box. */
function hasImageTextFit(image: StretchableImage): boolean {
  return Boolean(image.content && (image.textFitWidth || image.textFitHeight));
}

/** A position in an image along one axis: image pixels in fixed zones plus in stretched zones. */
type Cut = {fixed: number; stretch: number};

function sumWithinRange(ranges: [number, number][], min: number, max: number): number {
  let sum = 0;
  for (const [start, end] of ranges) {
    sum += Math.max(min, Math.min(max, end)) - Math.max(min, Math.min(max, start));
  }
  return sum;
}

/**
 * The edges between the fixed and the stretched zones of one axis. MapLibre also widens the first
 * and last by a pixel of the padding it puts around each image in its atlas; a sprite sheet has
 * none, so here the outer edges are the image's own.
 */
function stretchZonesToCuts(
  zones: [number, number][],
  fixedSize: number,
  stretchSize: number
): Cut[] {
  const cuts: Cut[] = [{fixed: 0, stretch: 0}];
  for (const [start, end] of zones) {
    const last = cuts[cuts.length - 1];
    cuts.push({fixed: start - last.stretch, stretch: last.stretch});
    cuts.push({fixed: start - last.stretch, stretch: last.stretch + (end - start)});
  }
  cuts.push({fixed: fixedSize, stretch: stretchSize});
  return cuts;
}

/**
 * MapLibre's `getIconQuads` for an icon fitted with {@link fitIconToText}: the rectangles that draw
 * it. An image without stretch zones is one rectangle, its `content` (or all of it) stretched over
 * the box. An image with `stretchX` / `stretchY` is cut at the zones' edges: the stretched zones
 * share what the box adds, and the fixed zones keep their size. Empty rectangles are left out.
 */
export function getIconQuads(image: StretchableImage, fitted: FittedIcon): IconQuad[] {
  const {width: imageWidth, height: imageHeight, pixelRatio, content} = image;
  const stretchX = image.stretchX?.length ? image.stretchX : null;
  const stretchY = image.stretchY?.length ? image.stretchY : null;
  const zonesX = stretchX || [[0, imageWidth] as [number, number]];
  const zonesY = stretchY || [[0, imageHeight] as [number, number]];
  const stretchWidth = sumWithinRange(zonesX, 0, imageWidth);
  const stretchHeight = sumWithinRange(zonesY, 0, imageHeight);
  const fixedWidth = imageWidth - stretchWidth;
  const fixedHeight = imageHeight - stretchHeight;

  let stretchOffsetX = 0;
  let stretchContentWidth = stretchWidth;
  let stretchOffsetY = 0;
  let stretchContentHeight = stretchHeight;
  let fixedOffsetX = 0;
  let fixedContentWidth = fixedWidth;
  let fixedOffsetY = 0;
  let fixedContentHeight = fixedHeight;
  let icon: SymbolBox = fitted;
  if (content) {
    if (hasImageTextFit(image)) {
      icon = applyTextFit(image, fitted);
    }
    stretchOffsetX = sumWithinRange(zonesX, 0, content[0]);
    stretchOffsetY = sumWithinRange(zonesY, 0, content[1]);
    stretchContentWidth = sumWithinRange(zonesX, content[0], content[2]);
    stretchContentHeight = sumWithinRange(zonesY, content[1], content[3]);
    fixedOffsetX = content[0] - stretchOffsetX;
    fixedOffsetY = content[1] - stretchOffsetY;
    fixedContentWidth = content[2] - content[0] - stretchContentWidth;
    fixedContentHeight = content[3] - content[1] - stretchContentHeight;
  }
  const iconWidth = icon.right - icon.left;
  const iconHeight = icon.bottom - icon.top;
  // A zone of no size stretches by nothing rather than by NaN.
  const getEmOffset = (offset: number, size: number, iconSize: number, iconOffset: number) =>
    (size ? (offset / size) * iconSize : 0) + iconOffset;
  const getPxOffset = (offset: number, size: number, stretch: number, stretchSize: number) =>
    offset - (stretchSize ? (size * stretch) / stretchSize : 0);
  const minScale: [number, number] = [
    iconWidth ? fixedContentWidth / pixelRatio / iconWidth : 0,
    iconHeight ? fixedContentHeight / pixelRatio / iconHeight : 0
  ];

  const makeQuad = (left: Cut, top: Cut, right: Cut, bottom: Cut): IconQuad | null => {
    const x1 = left.stretch + left.fixed;
    const x2 = right.stretch + right.fixed;
    const y1 = top.stretch + top.fixed;
    const y2 = bottom.stretch + bottom.fixed;
    if (!(x2 > x1 && y2 > y1)) {
      return null;
    }
    const emX = (cut: Cut) =>
      getEmOffset(cut.stretch - stretchOffsetX, stretchContentWidth, iconWidth, icon.left);
    const emY = (cut: Cut) =>
      getEmOffset(cut.stretch - stretchOffsetY, stretchContentHeight, iconHeight, icon.top);
    const pxX = (cut: Cut) =>
      getPxOffset(cut.fixed - fixedOffsetX, fixedContentWidth, cut.stretch, stretchWidth) /
      pixelRatio;
    const pxY = (cut: Cut) =>
      getPxOffset(cut.fixed - fixedOffsetY, fixedContentHeight, cut.stretch, stretchHeight) /
      pixelRatio;
    return {
      image: {x: x1, y: y1, width: x2 - x1, height: y2 - y1},
      em: {left: emX(left), top: emY(top), right: emX(right), bottom: emY(bottom)},
      px: {left: pxX(left), top: pxY(top), right: pxX(right), bottom: pxY(bottom)},
      minScale
    };
  };

  if (!stretchX && !stretchY) {
    const quad = makeQuad(
      {fixed: 0, stretch: 0},
      {fixed: 0, stretch: 0},
      {fixed: 0, stretch: imageWidth},
      {fixed: 0, stretch: imageHeight}
    );
    return quad ? [quad] : [];
  }
  const cutsX = stretchZonesToCuts(zonesX, fixedWidth, stretchWidth);
  const cutsY = stretchZonesToCuts(zonesY, fixedHeight, stretchHeight);
  const quads: IconQuad[] = [];
  for (let xi = 0; xi < cutsX.length - 1; xi++) {
    for (let yi = 0; yi < cutsY.length - 1; yi++) {
      const quad = makeQuad(cutsX[xi], cutsY[yi], cutsX[xi + 1], cutsY[yi + 1]);
      if (quad) {
        quads.push(quad);
      }
    }
  }
  return quads;
}

/** Where a quad is drawn at `icon-size`, as MapLibre's icon shader places its corners. */
export function getIconQuadBox(quad: IconQuad, iconSize: number): SymbolBox {
  const scaleX = Math.max(quad.minScale[0], iconSize);
  const scaleY = Math.max(quad.minScale[1], iconSize);
  return {
    left: quad.em.left * scaleX + quad.px.left,
    top: quad.em.top * scaleY + quad.px.top,
    right: quad.em.right * scaleX + quad.px.right,
    bottom: quad.em.bottom * scaleY + quad.px.bottom
  };
}

/**
 * The collision box of a fitted icon, `[x1, y1, x2, y2]`, as MapLibre's `CollisionFeature` makes
 * it: the fitted box at `icon-size`, padded by `icon-padding` (`[top, right, bottom, left]`), and
 * widened by the image outside its `content`.
 */
export function getFittedIconCollisionBox(
  image: StretchableImage,
  fitted: FittedIcon,
  iconSize: number,
  padding: readonly number[]
): [number, number, number, number] {
  const box = hasImageTextFit(image) ? applyTextFit(image, fitted) : fitted;
  const [padTop, padRight, padBottom, padLeft] = padding;
  const [outLeft, outTop, outRight, outBottom] = fitted.collisionPadding || [0, 0, 0, 0];
  return [
    box.left * iconSize - padLeft - outLeft * iconSize,
    box.top * iconSize - padTop - outTop * iconSize,
    box.right * iconSize + padRight + outRight * iconSize,
    box.bottom * iconSize + padBottom + outBottom * iconSize
  ];
}

/**
 * Whether a sprite image's stretch metadata is valid, as MapLibre's image manager checks it: zones
 * in order, each inside the image, and `content` inside the image with its corners in order.
 * MapLibre does not draw an image that fails.
 */
export function isValidStretchMetadata(image: StretchableImage): boolean {
  const isValidZones = (zones: unknown, size: number) => {
    if (zones === undefined) {
      return true;
    }
    if (!Array.isArray(zones)) {
      return false;
    }
    let last = 0;
    for (const zone of zones) {
      if (
        !Array.isArray(zone) ||
        zone.length !== 2 ||
        !zone.every(Number.isFinite) ||
        zone[0] < last ||
        zone[1] < zone[0] ||
        size < zone[1]
      ) {
        return false;
      }
      last = zone[1];
    }
    return true;
  };
  const {content, width, height} = image;
  const isValidContent =
    content === undefined ||
    (Array.isArray(content) &&
      content.length === 4 &&
      content.every(Number.isFinite) &&
      content[0] >= 0 &&
      content[0] <= width &&
      content[1] >= 0 &&
      content[1] <= height &&
      content[2] >= content[0] &&
      content[2] <= width &&
      content[3] >= content[1] &&
      content[3] <= height);
  return isValidZones(image.stretchX, width) && isValidZones(image.stretchY, height) && isValidContent;
}
