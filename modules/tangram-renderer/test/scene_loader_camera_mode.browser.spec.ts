// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {describe, expect, test} from 'vitest';
import SceneLoader from '../src/scene/scene_loader';

describe('SceneLoader camera mode defaults', () => {
  test('does not synthesize a Tangram camera for an external host camera', () => {
    const result = SceneLoader.finalize({config: {}, bundle: {}}, {cameraMode: 'external'});

    expect(result.config.cameras).toEqual({});
  });

  test('preserves the default camera for classic scene mode', () => {
    const result = SceneLoader.finalize({config: {}, bundle: {}}, {cameraMode: 'scene'});

    expect(result.config.cameras).toEqual({default: {}});
  });

  test('preserves authored cameras for an external host camera', () => {
    const cameras = {flat: {type: 'flat'}};
    const result = SceneLoader.finalize({config: {cameras}, bundle: {}}, {cameraMode: 'external'});

    expect(result.config.cameras).toBe(cameras);
  });
});
