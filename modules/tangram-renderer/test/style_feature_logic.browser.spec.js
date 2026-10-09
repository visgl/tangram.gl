// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {describe, expect, test, vi} from 'vitest';
import {Lines} from '../src/styles/lines/lines';
import {Points} from '../src/styles/points/points';
import {Polygons} from '../src/styles/polygons/polygons';
import {TextLabels} from '../src/styles/text/text_labels';
import LabelPoint from '../src/labels/label_point';
import StyleParser from '../src/styles/style_parser';
import Geo from '../src/utils/geo';

function createContext(overrides = {}) {
  return {
    feature: {properties: {height: 12}},
    geometry: 'line',
    layer: 'roads',
    tile: {overzoom2: 1, pad_scale: 1},
    units_per_meter_overzoom: 2,
    zoom: 10,
    ...overrides
  };
}

function createPointLayout(overrides = {}) {
  return {
    angle: 0,
    anchor: 'center',
    buffer: [0, 0],
    collide: false,
    offset: [0, 0],
    placement: LabelPoint.PLACEMENT.VERTEX,
    placement_min_length_ratio: 0,
    placement_spacing: 20,
    priority: 0,
    repeat_distance: 0,
    tile_edges: true,
    units_per_pixel: 1,
    ...overrides
  };
}

function createPoints() {
  const points = Object.create(Points);
  points.name = 'points-test';
  points.texture_missing_sprites = {};
  points.variants = {};
  points.vertex_layouts = {};
  points.vertex_template = [];
  points.getBlendOrderForDraw = draw => draw.blend_order || 0;
  points.addCustomAttributesToAttributeList = vi.fn();
  points.addCustomAttributesToVertexTemplate = vi.fn();
  return points;
}

function createLines() {
  const lines = Object.create(Lines);
  lines.name = 'lines-test';
  lines.feature_style = {};
  lines.inline_feature_style = lines.feature_style;
  lines.outline_feature_style = {};
  lines.variants = {};
  lines.vertex_layouts = {};
  lines.vertex_template = [];
  lines.styles = {'lines-test': lines};
  lines.dash_textures = {};
  lines.getBlendOrderForDraw = draw => draw.blend_order || 0;
  lines.parseOrder = value => value;
  lines.addCustomAttributesToAttributeList = vi.fn();
  lines.addCustomAttributesToVertexTemplate = vi.fn();
  return lines;
}

test('projected zoom-stop widths/offsets bake style zoom without geographic next-zoom interpolation', () => {
  const lines = createLines();
  lines.cpu_projection = {type: 'equal-earth'};
  const draw = lines._preprocess({width: [[4, '6px'], [6, '12px'], [8, '18px']],
    offset: [[4, '-1px'], [6, '2px']], color: '#fff'});
  for (const zoom of [4, 6, 8]) {
    const metersPerPixel = Geo.metersPerPixel(zoom);
    const context = createContext({zoom, meters_per_pixel: metersPerPixel});
    const style = {};
    lines.calcWidth(draw, style, context);
    lines.calcOffset(draw, style, context);
    expect(style.width_scale).toBe(0);
    expect(style.offset_scale).toBe(0);
    expect(style.width).toBeCloseTo((zoom === 4 ? 6 : zoom === 6 ? 12 : 18) * metersPerPixel * 2);
    expect(style.offset).toBeCloseTo((zoom === 4 ? -1 : 2) * metersPerPixel * 2);
    expect(style.projected_pixel_scale).toBe(1 / (metersPerPixel * 2));
  }
});

describe('point style behavior', () => {
  test('preprocesses draw properties and computes layout defaults', () => {
    const points = createPoints();
    const draw = points._preprocess({
      angle: 90,
      buffer: 3,
      color: '#ff0000',
      key: 'places',
      group: 'places',
      layers: ['places'],
      offset: [2, 4],
      order: 3,
      placement: 'spaced',
      repeat_distance: 10,
      repeat_group: context => context.layer,
      size: 24
    });
    const context = createContext();
    const layout = points.computeLayout({}, {id: 1}, draw, context, {units_per_pixel: 2});

    expect(draw.angle).toBeCloseTo(Math.PI / 2);
    expect(draw.placement).toBe(LabelPoint.PLACEMENT.SPACED);
    expect(layout).toMatchObject({
      buffer: [3, 3],
      collide: true,
      offset: [2, 4],
      repeat_distance: 20,
      repeat_group: 'roads',
      repeat_scale: 1,
      units_per_pixel: 2
    });
  });

  test('calculates explicit, sprite, scalar, and fallback sizes', () => {
    const points = createPoints();
    const context = createContext();
    const style = {};
    points.calcSize({size: null}, style, {css_size: [20, 30]}, context);
    expect(style.size).toEqual([20, 30]);

    points.calcSize({size: null}, style, null, context);
    expect(style.size).toEqual([16, 16]);

    const draw = points._preprocess({color: 'white', layers: ['places'], size: 12});
    points.calcSize(draw, style, null, context);
    expect(style.size).toEqual([12, 12]);
  });

  test.each([
    ['Point', [100, -100], 1],
    ['MultiPoint', [[100, -100], [200, -200]], 2],
    ['LineString', [[100, -100], [300, -100]], 2],
    ['MultiLineString', [[[100, -100], [300, -100]], [[400, -100], [600, -100]]], 4]
  ])('builds labels for %s geometry', (type, coordinates, count) => {
    const points = createPoints();
    const labels = points.buildLabels([10, 10], {type, coordinates}, createPointLayout());
    expect(labels).toHaveLength(count);
    expect(labels.every(label => label instanceof LabelPoint)).toBe(true);
  });

  test('builds centroid labels for polygons and multipolygons', () => {
    const points = createPoints();
    const ring = [[0, 0], [100, 0], [100, -100], [0, -100], [0, 0]];
    const layout = createPointLayout({placement: LabelPoint.PLACEMENT.CENTROID});
    expect(points.buildLabels([10, 10], {type: 'Polygon', coordinates: [ring]}, layout)).toHaveLength(1);
    expect(
      points.buildLabels([10, 10], {type: 'MultiPolygon', coordinates: [[[...ring]]]}, layout)
    ).toHaveLength(1);
  });

  test('creates and reuses rendering variants', () => {
    const points = createPoints();
    const shader = points.meshVariantTypeForDraw({blend_order: 1});
    const texture = points.meshVariantTypeForDraw({blend_order: 2, texture: 'icon-atlas'});
    const label = points.meshVariantTypeForDraw({blend_order: 3, label_texture: 'labels'});
    expect(shader).toMatchObject({point_type: 3, shader_point: true, mesh_order: 0});
    expect(texture).toMatchObject({point_type: 1, shader_point: false, mesh_order: 0});
    expect(label).toMatchObject({point_type: 2, shader_point: false, mesh_order: 1});
    expect(points.meshVariantTypeForDraw({blend_order: 1})).toBe(shader);
  });

  test('tracks collision label ranges and rejects empty quads', () => {
    const points = createPoints();
    const label = new LabelPoint([100, -100], [20, 10], createPointLayout({collide: true}));
    const mesh = {vertex_data: {offset: 80, stride: 10}};
    points.trackLabel(label, 99, mesh, 2);
    expect(mesh.labels[label.id].container.linked).toBe(99);
    expect(mesh.labels[label.id].ranges).toEqual([[40, 4]]);
    expect(points.buildQuad([0, 0], [0, 10])).toBe(0);
  });
});

describe('line style behavior', () => {
  test('calculates widths and offsets across zoom levels', () => {
    const lines = createLines();
    const context = createContext();
    const style = {};
    const draw = {
      width: StyleParser.createPropertyCache(3, StyleParser.parseUnits),
      offset: StyleParser.createPropertyCache(2, StyleParser.parseUnits),
      texcoords: true
    };
    expect(lines.calcWidth(draw, style, context)).toBe(true);
    lines.calcOffset(draw, style, context);
    expect(style).toMatchObject({width: 6, width_scale: 0, offset: 4, offset_scale: 0});

    lines.calcOffset({offset_precalc: 7, offset_scale_precalc: 0.25}, style, context);
    expect(style).toMatchObject({offset: 7, offset_scale: 0.25});
    expect(lines.calcWidth({width: StyleParser.createPropertyCache(0)}, {}, context)).toBe(false);
  });

  test('preprocesses a textured, dashed line and outline', () => {
    const lines = createLines();
    const draw = lines._preprocess({
      alpha: 0.5,
      blend_order: 4,
      cap: 'round',
      color: '#336699',
      dash: [2, 1],
      dash_background_color: '#000000',
      extrude: true,
      interactive: true,
      join: 'bevel',
      layers: ['roads'],
      miter_limit: 2,
      offset: context => `${context.zoom}px`,
      outline: {color: '#ffffff', width: '1px'},
      width: context => `${context.zoom}px`,
      z: '2m'
    });
    expect(draw.dash_key).toBe('__dash_[2,1]');
    expect(draw.texture_merged).toBe(draw.dash_key);
    expect(draw.outline).toMatchObject({
      cap: 'round',
      interactive: true,
      is_outline: true,
      join: 'bevel',
      style: 'lines-test'
    });
    expect(lines.variants[draw.variant]).toMatchObject({selection: 1, texcoords: 1});
    expect(lines.variants[draw.outline.variant].mesh_order).toBe(0);
  });

  test('parses feature height, extrusion, color, order, and outline', () => {
    const lines = createLines();
    const draw = lines._preprocess({
      cap: 'butt',
      color: '#ff0000',
      extrude: [0, 20],
      join: 'miter',
      layers: ['roads'],
      miter_limit: 3,
      order: 5,
      outline: {color: '#000000', order: 9, width: '1px'},
      width: '3px',
      z: '2m'
    });
    lines.feature_style = {order: 5};
    const result = lines._parseFeature(
      {properties: {height: 12}},
      draw,
      createContext()
    );
    expect(result.color).toEqual([1, 0, 0, 1]);
    expect(result.height).toBe(20);
    expect(result.z).toBeGreaterThan(0);
    expect(result.outline.order).toBe(4.5);
    expect(result.outline.width.value).toBeGreaterThan(result.width_unscaled);
  });

  test('creates line vertex templates for portable and classic variants', () => {
    const lines = createLines();
    const style = {
      alpha: 0.5,
      color: [0.2, 0.4, 0.6, 1],
      offset_scale: 0.25,
      order: 2,
      selection_color: [1, 0, 0, 1],
      width_scale: 0.5,
      z: 3
    };
    lines.scaleOrder = value => value;

    lines.shader_language = 'glsl';
    expect(
      lines.makeVertexTemplate(style, {variant: {offset: 1, selection: 1, texcoords: 1, z_or_offset: 1}})
    ).toContain(127.5);

    lines.vertex_template = [];
    lines.shader_language = 'wgsl';
    const portable = lines.makeVertexTemplate(
      style,
      {variant: {offset: 0, selection: 0, texcoords: 0, z_or_offset: 0}}
    );
    expect(portable.slice(6, 10)).toEqual([0, 0, 3, 256]);
  });
});

describe('text label style behavior', () => {
  function createTextStyle() {
    return {
      ...TextLabels,
      computeLayout(target, feature, draw, context, tile) {
        return Object.assign(target, {
          id: feature,
          repeat_distance: draw.repeat_distance,
          repeat_group: draw.repeat_group,
          units_per_pixel: tile.units_per_pixel || 1
        });
      },
      texts: {}
    };
  }

  test('resolves text properties, functions, and fallback arrays', () => {
    const style = createTextStyle();
    const feature = {properties: {name: 'Broadway', short_name: 'Bway'}};
    expect(style.parseTextSourceValue('name', feature, {})).toBe('Broadway');
    expect(style.parseTextSourceValue(['missing', 'short_name'], feature, {})).toBe('Bway');
    expect(style.parseTextSourceValue([() => 'Dynamic'], feature, {})).toBe('Dynamic');
    expect(style.parseTextSource(feature, {text_source: {left: 'name', right: 'short_name'}}, {}))
      .toEqual({left: 'Broadway', right: 'Bway'});
  });

  test('preprocesses full font styling and computes settings', () => {
    const style = createTextStyle();
    const draw = style.preprocessText({
      buffer: 2,
      font: {
        background: {
          color: '#000000',
          stroke: {color: '#ffffff', width: 1},
          width: 3
        },
        fill: '#ff0000',
        size: '16px',
        stroke: {color: '#00ff00', width: 2},
        weight: 600
      },
      offset: [1, 2],
      repeat_distance: 100
    });
    expect(draw.font.px_size).toBeDefined();
    expect(draw.font.background.stroke.width).toBeDefined();
    expect(draw.buffer).toBeDefined();
  });

  test('records unique single and boundary labels', () => {
    const style = createTextStyle();
    const tile = {id: 'tile', overzoom2: 2, units_per_pixel: 1};
    const context = createContext({geometry: 'point'});
    const baseDraw = style.preprocessText({font: {fill: '#fff', size: '12px'}});
    baseDraw.can_articulate = false;
    baseDraw.repeat_group = 'labels';

    const single = style.parseTextFeature(
      {properties: {name: 'Broadway'}},
      {...baseDraw, text_source: 'name'},
      context,
      tile
    );
    expect(single.text).toBe('Broadway');

    const boundary = style.parseTextFeature(
      {properties: {left: 'New York', right: 'New Jersey'}},
      {...baseDraw, text_source: {left: 'left', right: 'right'}},
      context,
      tile
    );
    expect(boundary).toHaveLength(2);
    expect(boundary.map(item => item.layout.orientation)).toEqual([-1, 1]);
  });

  test('culls unused text styles and preserves referenced labels', () => {
    const style = createTextStyle();
    const texts = {
      first: {Broadway: {ref: 0}, Unused: {ref: 0}},
      empty: {Gone: {ref: 0}}
    };
    style.cullTextStyles(texts, [{text_settings_key: 'first', text: 'Broadway'}]);
    expect(texts).toEqual({first: {Broadway: {ref: 1}}});
  });
});

describe('polygon style behavior', () => {
  function createPolygons() {
    const polygons = Object.create(Polygons);
    polygons.feature_style = {};
    polygons.variants = {};
    polygons.vertex_layouts = {};
    polygons.vertex_template = [];
    polygons.texcoords = true;
    polygons.shaders = {blocks: {}};
    polygons.getBlendOrderForDraw = draw => draw.blend_order || 0;
    polygons.scaleOrder = value => value;
    polygons.addCustomAttributesToAttributeList = vi.fn();
    polygons.addCustomAttributesToVertexTemplate = vi.fn();
    return polygons;
  }

  test.each([
    [true, 12, 3],
    [25, 25, 0],
    [[4, 30], 30, 4]
  ])('parses extrusion %j', (extrude, height, minHeight) => {
    const polygons = createPolygons();
    const draw = polygons._preprocess({
      blend_order: 2,
      color: '#336699',
      extrude,
      interactive: true,
      tile_edges: false,
      z: '2m'
    });
    polygons.feature_style = {order: 3};
    const style = polygons._parseFeature(
      {properties: {height: 12, min_height: 3}},
      draw,
      createContext()
    );
    expect(style.color).toEqual([0.2, 0.4, 0.6, 1]);
    expect(style.height).toBe(height * 16);
    expect(style.min_height).toBe(minHeight * 16);
    expect(polygons.meshVariantTypeForDraw(draw)).toMatchObject({
      blend_order: 2,
      normal: 1,
      selection: 1,
      texcoords: 1
    });
  });

  test('rejects missing colors and creates flat variants', () => {
    const polygons = createPolygons();
    const draw = polygons._preprocess({color: null, interactive: false});
    expect(polygons._parseFeature({properties: {}}, draw, createContext())).toBeNull();
    expect(polygons.meshVariantTypeForDraw(draw)).toMatchObject({normal: 0, selection: 0});
  });

  test('creates classic and portable vertex layouts and templates', () => {
    const polygons = createPolygons();
    const variant = {
      key: 'polygon',
      normal: 0,
      selection: 1,
      texcoords: 1
    };
    polygons.shader_language = 'glsl';
    const classic = polygons.vertexLayoutForMeshVariant(variant);
    expect(classic.static_attribs.find(attribute => attribute.name === 'a_normal').static)
      .toEqual([0, 0, 1]);

    polygons.shader_language = 'wgsl';
    polygons.vertex_layouts = {};
    const portable = polygons.vertexLayoutForMeshVariant(variant);
    expect(portable.dynamic_attribs.find(attribute => attribute.name === 'a_normal').size).toBe(4);

    const template = polygons.makeVertexTemplate(
      {
        alpha: 0.5,
        color: [1, 0.5, 0.25, 1],
        order: 4,
        selection_color: [0, 1, 0, 1],
        z: 8
      },
      {variant}
    );
    expect(template).toContain(127);
    expect(template).toContain(127.5);
    expect(template).toContain(8);
  });
});
