// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

// The Earth's cloud map: NASA Blue Marble clouds, 2048 x 1024 plate carree (see data/provenance.json).

export const EARTH_CLOUD_MAP_URL = new URL('./data/earth-clouds-2048.jpg', import.meta.url).href;
export const EARTH_CLOUD_CREDIT = 'Clouds: NASA Blue Marble clouds, NASA GSFC, Reto Stöckli (public domain).';

let cloudMap: Promise<ImageBitmap> | null = null;
/** The cloud map, loaded once. */
export function getEarthCloudMap(): Promise<ImageBitmap> {
  cloudMap ??= fetch(EARTH_CLOUD_MAP_URL)
    .then(response => {
      if (!response.ok) throw new Error(`cloud map: HTTP ${response.status}`);
      return response.blob();
    })
    .then(blob => createImageBitmap(blob));
  return cloudMap;
}
