// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

// A minimal Mapbox Vector Tile (MVT 2.1) decoder for the overview texture of the Earth: the
// layer name, the string and number properties, and the geometry as rings or lines in tile
// coordinates (0 to extent). See https://github.com/mapbox/vector-tile-spec.

export type MVTFeature = {
  layer: string;
  /** 1 point, 2 line, 3 polygon. */
  type: number;
  properties: Record<string, string | number | boolean>;
  /** Lines or rings, tile coordinates. */
  geometry: [number, number][][];
  extent: number;
};

class Reader {
  pos = 0;
  constructor(readonly buf: Uint8Array, readonly end = buf.length) {}
  varint(): number {
    let result = 0;
    let shift = 1;
    for (;;) {
      const b = this.buf[this.pos++];
      result += (b & 0x7f) * shift;
      if (b < 0x80) return result;
      shift *= 128;
    }
  }
  bytes(): Uint8Array {
    const n = this.varint();
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  skip(wire: number) {
    if (wire === 0) this.varint();
    else if (wire === 1) this.pos += 8;
    else if (wire === 2) this.pos += this.varint();
    else if (wire === 5) this.pos += 4;
    else throw new Error(`MVT: wire type ${wire}`);
  }
  packed(): number[] {
    const sub = new Reader(this.bytes());
    const out: number[] = [];
    while (sub.pos < sub.end) out.push(sub.varint());
    return out;
  }
}

const decoder = new TextDecoder();
const zigzag = (n: number) => (n % 2 ? -(n + 1) / 2 : n / 2);

function readValue(bytes: Uint8Array): string | number | boolean {
  const r = new Reader(bytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let value: string | number | boolean = '';
  while (r.pos < r.end) {
    const tag = r.varint();
    const field = tag >> 3;
    if (field === 1) value = decoder.decode(r.bytes());
    else if (field === 2) {
      value = view.getFloat32(r.pos, true);
      r.pos += 4;
    } else if (field === 3) {
      value = view.getFloat64(r.pos, true);
      r.pos += 8;
    }
    else if (field === 4 || field === 5) value = r.varint();
    else if (field === 6) value = zigzag(r.varint());
    else if (field === 7) value = r.varint() !== 0;
    else r.skip(tag & 7);
  }
  return value;
}

function readGeometry(commands: number[]): [number, number][][] {
  const parts: [number, number][][] = [];
  let x = 0;
  let y = 0;
  let current: [number, number][] = [];
  for (let i = 0; i < commands.length; ) {
    const command = commands[i] & 7;
    const count = commands[i++] >> 3;
    if (command === 7) {
      if (current.length) current.push(current[0]);
      continue;
    }
    for (let k = 0; k < count; k++) {
      x += zigzag(commands[i++]);
      y += zigzag(commands[i++]);
      if (command === 1) {
        if (current.length) parts.push(current);
        current = [];
      }
      current.push([x, y]);
    }
  }
  if (current.length) parts.push(current);
  return parts;
}

/** The features of the named layers of a tile. */
export function decodeMVT(data: ArrayBuffer, layers: readonly string[]): MVTFeature[] {
  const tile = new Reader(new Uint8Array(data));
  const features: MVTFeature[] = [];
  while (tile.pos < tile.end) {
    const tag = tile.varint();
    if (tag >> 3 !== 3) {
      tile.skip(tag & 7);
      continue;
    }
    const layer = new Reader(tile.bytes());
    let name = '';
    let extent = 4096;
    const keys: string[] = [];
    const values: (string | number | boolean)[] = [];
    const raw: {tags: number[]; type: number; geometry: number[]}[] = [];
    while (layer.pos < layer.end) {
      const t = layer.varint();
      const field = t >> 3;
      if (field === 1) name = decoder.decode(layer.bytes());
      else if (field === 3) keys.push(decoder.decode(layer.bytes()));
      else if (field === 4) values.push(readValue(layer.bytes()));
      else if (field === 5) extent = layer.varint();
      else if (field === 2) {
        const f = new Reader(layer.bytes());
        const feature = {tags: [] as number[], type: 0, geometry: [] as number[]};
        while (f.pos < f.end) {
          const ft = f.varint();
          const ff = ft >> 3;
          if (ff === 2) feature.tags = f.packed();
          else if (ff === 3) feature.type = f.varint();
          else if (ff === 4) feature.geometry = f.packed();
          else f.skip(ft & 7);
        }
        raw.push(feature);
      } else layer.skip(t & 7);
    }
    if (!layers.includes(name)) continue;
    for (const f of raw) {
      const properties: Record<string, string | number | boolean> = {};
      for (let i = 0; i + 1 < f.tags.length; i += 2) properties[keys[f.tags[i]]] = values[f.tags[i + 1]];
      features.push({layer: name, type: f.type, properties, geometry: readGeometry(f.geometry), extent});
    }
  }
  return features;
}
