// Tangram
// SPDX-License-Identifier: MIT
// Copyright (c) 2013-2016 Brett Camper and Mapzen
// Copyright (c) 2026 vis.gl contributors

import yaml from 'js-yaml';

/**
 * Parse a Tangram scene using the renderer's established js-yaml implementation.
 * @param {string} source YAML scene source.
 * @returns Parsed YAML value; scene interpretation and schema validation are separate boundaries.
 */
export function parseSceneYamlLegacy(source: string): unknown {
    // Existing Tangram behavior allows duplicate keys despite the YAML specification.
    return yaml.safeLoad(source, { json: true });
}
