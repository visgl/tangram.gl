// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {loadClassicEditorScene} from './scene-editor.js';

/** Adapt community's cancellable updates to Tangram's serialized scene loader. */
export function createClassicPlaygroundRenderer({scene, resolveSceneUrl, mapElement = null, debounceMs = 400}) {
  let disposed = false;
  let loadQueue = Promise.resolve();
  let cancelDelay;
  const originalParent = mapElement?.parentElement;
  const originalNextSibling = mapElement?.nextSibling;

  return {
    /** Debounce edits, retain the template's import base and never overlap Scene.load. */
    async update(previewElement, value, _text, context) {
      const {signal, templateId} = context;
      if (disposed || signal.aborted) return;
      if (mapElement && mapElement.parentElement !== previewElement) {
        previewElement.append(mapElement);
      }
      await new Promise(resolve => {
        const finish = () => {
          clearTimeout(timer);
          signal.removeEventListener('abort', finish);
          if (cancelDelay === finish) cancelDelay = undefined;
          resolve();
        };
        const timer = setTimeout(finish, debounceMs);
        cancelDelay = finish;
        signal.addEventListener('abort', finish, {once: true});
      });
      const isObsolete = () => disposed || signal.aborted;
      if (isObsolete()) return;
      const loading = loadQueue.then(async () => {
        if (isObsolete()) return;
        await loadClassicEditorScene(scene, value, {
          base_path: new URL('.', resolveSceneUrl(templateId)).href
        }, isObsolete);
      });
      // A rejection belongs to that update, but must not poison the next edit.
      loadQueue = loading.catch(() => {});
      await loading;
    },
    /** Restore the host-owned map; the classic bootstrap still owns its destruction. */
    finalize() {
      if (disposed) return;
      disposed = true;
      cancelDelay?.();
      if (mapElement && originalParent) {
        originalParent.insertBefore(mapElement,
          originalNextSibling?.parentNode === originalParent ? originalNextSibling : null);
      }
    }
  };
}
