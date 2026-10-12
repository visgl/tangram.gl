// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test} from 'vitest';
import {formatTerrainDecoderStatus} from '../examples/terrain/decoder-status';

test('decoder diagnostics distinguish retained grids/meshes and round-trip/decode elapsed time', () => {
    const statistics = {created: 2, active: 1, idle: 1, completed: 20, failed: 0, cancelled: 1};
    expect(formatTerrainDecoderStatus(statistics, {gridBytes: 1500000, meshBytes: 0})).toBe('Decoder: 2 workers created · 1 warm · 20 jobs · 1.5 MB grids · 0.0 MB source meshes');
    expect(formatTerrainDecoderStatus({...statistics, lastRoundTripMs: 12.4, lastDecodeMs: 5.1}, {gridBytes: 0, meshBytes: 1000000})).toContain('12 ms round trip / 5 ms decode elapsed');
    expect(formatTerrainDecoderStatus({...statistics, lastRoundTripMs: 0}, {gridBytes: 0, meshBytes: 0})).toContain('0 ms round trip / — ms decode elapsed');
});
