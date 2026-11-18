// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

// Generates world tiles off the main thread. Keeps the last two worlds.

import {generateTile} from './tile';
import {buildWorld, type World} from './world';

type Request = {id: number; seed: number; sea: number; z: number; x: number; y: number};

const worlds = new Map<string, World>();

function getWorld(seed: number, sea: number): World {
  const key = `${seed}:${sea}`;
  let world = worlds.get(key);
  if (!world) {
    world = buildWorld({seed, seaLevel: sea});
    worlds.set(key, world);
    while (worlds.size > 2) worlds.delete(worlds.keys().next().value!);
  }
  return world;
}

self.onmessage = (event: MessageEvent<Request>) => {
  const {id, seed, sea, z, x, y} = event.data;
  try {
    const start = performance.now();
    const fresh = !worlds.has(`${seed}:${sea}`);
    const world = getWorld(seed, sea);
    const tileStart = performance.now();
    const bytes = generateTile(world, z, x, y);
    const end = performance.now();
    (self as unknown as Worker).postMessage(
      {id, bytes, tileMs: end - tileStart, worldMs: fresh ? tileStart - start : 0},
      [bytes.buffer]
    );
  } catch (error) {
    (self as unknown as Worker).postMessage({id, error: String(error)});
  }
};
