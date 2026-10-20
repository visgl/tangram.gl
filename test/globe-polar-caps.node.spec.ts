// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test} from 'vitest';
import {createGlobePolarCapMesh, createGlobePolarCaps} from '../examples/deck/globe-polar-caps';

test('polar caps close both poles with finite sea-level geometry outside the tile domain', () => {
  const mesh = createGlobePolarCapMesh();
  const positions = mesh.attributes.POSITION.value;
  expect(positions.length / 3).toBeLessThan(65536);
  expect(mesh.indices.value.length % 3).toBe(0);
  expect(Math.max(...mesh.indices.value)).toBeLessThan(positions.length / 3);
  let north = false, south = false;
  for (let index = 0; index < positions.length; index += 3) {
    expect(Number.isFinite(positions[index])).toBe(true);
    expect(Math.abs(positions[index])).toBeLessThanOrEqual(180);
    expect(Math.abs(positions[index + 1])).toBeGreaterThan(85);
    expect(Math.abs(positions[index + 1])).toBeLessThanOrEqual(90);
    expect(positions[index + 2]).toBe(0);
    north ||= positions[index + 1] === 90;
    south ||= positions[index + 1] === -90;
  }
  expect(north && south).toBe(true);
});

test('caps are unlit non-pickable example layers and follow basemap visibility', () => {
  const layer = createGlobePolarCaps([245, 243, 239], false);
  expect(layer.props.material).toMatchObject({unlit: true});
  expect(layer.props.pickable).toBe(false);
  expect(layer.props.visible).toBe(false);
  expect(layer.props.getColor).toEqual([245, 243, 239]);
});
