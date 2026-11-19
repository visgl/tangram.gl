// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/** A longitude/latitude position. */
export type Position = [longitude: number, latitude: number];

/** A track, with the distance in meters from its start to each of its positions. */
export type Track = {
  positions: Position[];
  distances: number[];
  length: number;
};

export type SurveyTrackOptions = {
  /** The center of the surveyed area. */
  center: Position;
  /** The direction of the survey lines, in degrees clockwise from north. */
  bearing: number;
  lineCount: number;
  /** The length of the straight part of each line, in meters. */
  lineLength: number;
  /** The distance between two lines, in meters. */
  lineSpacing: number;
};

const METERS_PER_DEGREE = 111_320;
const TURN_STEPS = 16;

/**
 * A survey track of parallel lines, as a vehicle that maps an area follows: each line is joined to
 * the next by a half circle.
 */
export function createSurveyTrack(options: SurveyTrackOptions): Track {
  const {center, lineCount, lineLength, lineSpacing} = options;
  const bearing = (options.bearing * Math.PI) / 180;
  const radius = lineSpacing / 2;
  // Local meters: x across the lines, y along them.
  const local: [number, number][] = [];
  for (let line = 0; line < lineCount; line++) {
    const x = (line - (lineCount - 1) / 2) * lineSpacing;
    const direction = line % 2 === 0 ? 1 : -1;
    local.push([x, (-direction * lineLength) / 2], [x, (direction * lineLength) / 2]);
    if (line < lineCount - 1) {
      for (let step = 1; step < TURN_STEPS; step++) {
        const angle = (Math.PI * step) / TURN_STEPS;
        local.push([
          x + radius - radius * Math.cos(angle),
          (direction * lineLength) / 2 + direction * radius * Math.sin(angle)
        ]);
      }
    }
  }

  const metersPerDegreeLongitude = METERS_PER_DEGREE * Math.cos((center[1] * Math.PI) / 180);
  const positions: Position[] = [];
  const distances: number[] = [];
  let length = 0;
  for (let index = 0; index < local.length; index++) {
    const [x, y] = local[index];
    if (index > 0) {
      length += Math.hypot(x - local[index - 1][0], y - local[index - 1][1]);
    }
    const east = x * Math.cos(bearing) + y * Math.sin(bearing);
    const north = y * Math.cos(bearing) - x * Math.sin(bearing);
    positions.push([
      center[0] + east / metersPerDegreeLongitude,
      center[1] + north / METERS_PER_DEGREE
    ]);
    distances.push(length);
  }
  return {positions, distances, length};
}

/** The part of a track from its start to `distance` meters along it. It has two positions or more. */
export function getTrackStart(track: Track, distance: number): Position[] {
  const {positions, distances} = track;
  const end = Math.min(Math.max(distance, 0), track.length);
  let index = 1;
  while (index < positions.length - 1 && distances[index] < end) {
    index++;
  }
  const from = positions[index - 1];
  const to = positions[index];
  const span = distances[index] - distances[index - 1];
  const ratio = span > 0 ? (end - distances[index - 1]) / span : 0;
  return [
    ...positions.slice(0, index),
    [from[0] + (to[0] - from[0]) * ratio, from[1] + (to[1] - from[1]) * ratio]
  ];
}

const DISC_STEPS = 24;

/**
 * The area within `width / 2` meters of a path, as polygons that overlap: a rectangle for each
 * segment and a disc at each position. A mask layer draws them as one shape.
 */
export function getCorridorPolygons(path: Position[], width: number): Position[][] {
  const radius = width / 2;
  const polygons: Position[][] = [];
  for (let index = 0; index < path.length; index++) {
    const position = path[index];
    const metersPerDegreeLongitude =
      METERS_PER_DEGREE * Math.cos((position[1] * Math.PI) / 180);
    const offset = (east: number, north: number, from = position): Position => [
      from[0] + east / metersPerDegreeLongitude,
      from[1] + north / METERS_PER_DEGREE
    ];
    const disc: Position[] = [];
    for (let step = 0; step < DISC_STEPS; step++) {
      const angle = (2 * Math.PI * step) / DISC_STEPS;
      disc.push(offset(radius * Math.cos(angle), radius * Math.sin(angle)));
    }
    polygons.push(disc);

    const next = path[index + 1];
    if (next) {
      const east = (next[0] - position[0]) * metersPerDegreeLongitude;
      const north = (next[1] - position[1]) * METERS_PER_DEGREE;
      const length = Math.hypot(east, north);
      if (length > 0) {
        // The normal of the segment, `radius` meters long.
        const normalEast = (-north / length) * radius;
        const normalNorth = (east / length) * radius;
        polygons.push([
          offset(normalEast, normalNorth),
          offset(normalEast, normalNorth, next),
          offset(-normalEast, -normalNorth, next),
          offset(-normalEast, -normalNorth)
        ]);
      }
    }
  }
  return polygons;
}
