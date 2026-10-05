// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

// Resolve example-only UI dependencies in the example workspace, including tests.
import {Playground} from '@deck.gl-community/playground';
import {SettingsPanel} from '@deck.gl-community/panels';

/** Construct the published UI with the scene-specific host options. */
export function createCommunityPlayground(options) {
  return new Playground(options);
}

/** Construct the community settings tab without depending on deck's widgets. */
export function createCommunitySettingsPanel(options) {
  return new SettingsPanel(options);
}
