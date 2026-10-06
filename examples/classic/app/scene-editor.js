// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/**
 * Wait for initial renderer startup, and turn Scene's error-and-revert event
 * into an editor error even when its fallback load resolves successfully.
 */
export async function loadClassicEditorScene(scene, config, options, isDisposed) {
  try {
    if (scene.initializing) await scene.initializing;
  } catch (error) {
    if (isDisposed()) return;
    throw error;
  }
  if (isDisposed()) return;
  let loadError;
  const listener = {error: event => {
    // Scene.load emits an untyped initialization error or a YAML error before
    // reverting. Import and resource errors are recoverable notifications.
    if (event.type === undefined || event.type === 'yaml') {
      loadError = event.error || new Error(event.message);
    }
  }};
  scene.subscribe(listener);
  try {
    await scene.load(config, options);
    if (!isDisposed() && loadError) throw loadError;
  } catch (error) {
    // A superseded load must settle before the next serialized edit, but its
    // failure no longer belongs to the current editor document.
    if (!isDisposed()) throw error;
  } finally {
    scene.unsubscribe(listener);
  }
}
