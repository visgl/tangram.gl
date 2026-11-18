// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

// A small Mapbox Vector Tile 2.1 encoder.

/** A minimal protocol buffer writer: the field types that a vector tile uses. */
class ProtobufWriter {
  private bytes = new Uint8Array(1024);
  private length = 0;
  private static readonly encoder = new TextEncoder();
  private static readonly scratch = new DataView(new ArrayBuffer(8));

  private reserve(count: number): void {
    if (this.length + count <= this.bytes.length) return;
    let size = this.bytes.length * 2;
    while (size < this.length + count) size *= 2;
    const bytes = new Uint8Array(size);
    bytes.set(this.bytes.subarray(0, this.length));
    this.bytes = bytes;
  }

  private writeRaw(bytes: Uint8Array): void {
    this.reserve(bytes.length);
    this.bytes.set(bytes, this.length);
    this.length += bytes.length;
  }

  /** Writes a non-negative integer of up to 2^53 as a varint. */
  writeVarint(value: number): void {
    this.reserve(10);
    let rest = value;
    while (rest >= 0x80) {
      this.bytes[this.length++] = (rest % 0x80) | 0x80;
      rest = Math.floor(rest / 0x80);
    }
    this.bytes[this.length++] = rest;
  }

  private writeTag(field: number, wireType: number): void {
    this.writeVarint(field * 8 + wireType);
  }

  writeVarintField(field: number, value: number): void {
    this.writeTag(field, 0);
    this.writeVarint(value);
  }

  writeSVarintField(field: number, value: number): void {
    this.writeTag(field, 0);
    this.writeVarint(value < 0 ? -value * 2 - 1 : value * 2);
  }

  writeBooleanField(field: number, value: boolean): void {
    this.writeVarintField(field, value ? 1 : 0);
  }

  writeDoubleField(field: number, value: number): void {
    this.writeTag(field, 1);
    ProtobufWriter.scratch.setFloat64(0, value, true);
    this.writeRaw(new Uint8Array(ProtobufWriter.scratch.buffer.slice(0)));
  }

  writeBytesField(field: number, bytes: Uint8Array): void {
    this.writeTag(field, 2);
    this.writeVarint(bytes.length);
    this.writeRaw(bytes);
  }

  writeStringField(field: number, value: string): void {
    this.writeBytesField(field, ProtobufWriter.encoder.encode(value));
  }

  writePackedVarint(field: number, values: number[]): void {
    if (!values.length) return;
    const packed = new ProtobufWriter();
    for (const value of values) packed.writeVarint(value);
    this.writeBytesField(field, packed.finish());
  }

  writeMessage<T>(field: number, write: (value: T, writer: ProtobufWriter) => void, value: T): void {
    const message = new ProtobufWriter();
    write(value, message);
    this.writeBytesField(field, message.finish());
  }

  finish(): Uint8Array {
    return this.bytes.slice(0, this.length);
  }
}

export type TileValue = string | number | boolean;
export type TileFeature =
  | {type: 1; geometry: [number, number][]; properties: Record<string, TileValue>}
  | {type: 2; geometry: [number, number][][]; properties: Record<string, TileValue>}
  | {type: 3; geometry: [number, number][][][]; properties: Record<string, TileValue>};
export type TileLayer = {name: string; extent: number; features: TileFeature[]};

const command = (id: number, count: number) => (count << 3) | id;
const zigzag = (n: number) => (n << 1) ^ (n >> 31);

function encodeGeometry(feature: TileFeature): number[] {
  const out: number[] = [];
  let x = 0;
  let y = 0;
  const moveTo = (p: [number, number]) => {
    out.push(command(1, 1), zigzag(p[0] - x), zigzag(p[1] - y));
    [x, y] = p;
  };
  const lineTo = (points: [number, number][]) => {
    out.push(command(2, points.length));
    for (const p of points) {
      out.push(zigzag(p[0] - x), zigzag(p[1] - y));
      [x, y] = p;
    }
  };
  if (feature.type === 1) {
    out.push(command(1, feature.geometry.length));
    for (const p of feature.geometry) {
      out.push(zigzag(p[0] - x), zigzag(p[1] - y));
      [x, y] = p;
    }
  } else if (feature.type === 2) {
    for (const line of feature.geometry) {
      moveTo(line[0]);
      lineTo(line.slice(1));
    }
  } else {
    for (const polygon of feature.geometry)
      for (const ring of polygon) {
        moveTo(ring[0]);
        lineTo(ring.slice(1));
        out.push(command(7, 1));
      }
  }
  return out;
}

function writeValue(value: TileValue, pbf: ProtobufWriter) {
  if (typeof value === 'string') pbf.writeStringField(1, value);
  else if (typeof value === 'boolean') pbf.writeBooleanField(7, value);
  else if (Number.isInteger(value)) {
    if (value < 0) pbf.writeSVarintField(6, value);
    else pbf.writeVarintField(5, value);
  } else pbf.writeDoubleField(3, value);
}

function writeLayer(layer: TileLayer, pbf: ProtobufWriter) {
  pbf.writeVarintField(15, 2);
  pbf.writeStringField(1, layer.name);
  pbf.writeVarintField(5, layer.extent);
  const keys = new Map<string, number>();
  const values = new Map<string, number>();
  const valueList: TileValue[] = [];
  for (const feature of layer.features) {
    const tags: number[] = [];
    for (const [key, value] of Object.entries(feature.properties)) {
      if (!keys.has(key)) keys.set(key, keys.size);
      const valueKey = `${typeof value}:${value}`;
      if (!values.has(valueKey)) {
        values.set(valueKey, valueList.length);
        valueList.push(value);
      }
      tags.push(keys.get(key)!, values.get(valueKey)!);
    }
    pbf.writeMessage(
      2,
      (f: TileFeature, p: ProtobufWriter) => {
        p.writePackedVarint(2, tags);
        p.writeVarintField(3, f.type);
        p.writePackedVarint(4, encodeGeometry(f));
      },
      feature
    );
  }
  for (const key of keys.keys()) pbf.writeStringField(3, key);
  for (const value of valueList) pbf.writeMessage(4, writeValue, value);
}

/** Encodes layers as a vector tile. Layers without features are left out. */
export function encodeTile(layers: TileLayer[]): Uint8Array {
  const pbf = new ProtobufWriter();
  for (const layer of layers) {
    if (layer.features.length) pbf.writeMessage(3, writeLayer, layer);
  }
  return pbf.finish();
}
