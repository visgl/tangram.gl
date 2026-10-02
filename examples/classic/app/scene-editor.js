// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/**
 * Coordinate style selection and debounced edits without depending on Monaco.
 * Source requests are cancellable; renderer loads are awaited and stale results
 * cannot replace the selected document or report status for a newer edit.
 * @param {object} options Example-local renderer and presentation callbacks.
 * @param {string} options.initialScene Initial style URL.
 * @param {string} options.initialSource Initial editor text.
 * @param {(url: string, signal: AbortSignal) => Promise<string>} options.fetchSource Fetch a style document.
 * @param {(source: string) => string} options.formatSource Convert fetched YAML to editor text.
 * @param {(source: string) => object} options.parseSource Parse edited text.
 * @param {(scene: string | object, options?: {base_path: string}) => Promise<unknown>} options.loadScene Load a URL or edited scene.
 * @param {(url: string) => string} options.resolveSceneUrl Resolve relative style URLs.
 * @param {(document: {source: string, status: string, message: string, readOnly: boolean}) => void} options.onDocumentChange Present controlled editor state.
 * @param {(url: string) => void} options.onSceneSelected Update the selector's URL and basemap.
 * @param {number} [options.debounceMs] Delay before applying an edit.
 */
export function createSceneEditorController({
  initialScene, initialSource, fetchSource, formatSource, parseSource, loadScene,
  resolveSceneUrl, onDocumentChange, onSceneSelected, debounceMs = 400
}) {
  let activeScene = initialScene;
  let document = {source: initialSource, status: 'ready', message: '', readOnly: false};
  let revision = 0;
  let applyTimer;
  let sourceRequest;
  let disposed = false;
  let loadQueue = Promise.resolve();

  /** Notify the UI only while this example is mounted. */
  function updateDocument(update) {
    document = {...document, ...update};
    if (!disposed) onDocumentChange({...document});
  }

  /** Cancel work that has not yet reached the renderer. */
  function cancelPendingWork() {
    clearTimeout(applyTimer);
    sourceRequest?.abort();
  }

  /** Serialize renderer loads: Scene.load otherwise returns its existing initialization promise. */
  function enqueueScene(config, options, currentRevision) {
    const loading = loadQueue.then(() => {
      if (disposed || revision !== currentRevision) return;
      return loadScene(config, options);
    });
    // An unsuccessful edit must not poison the next selection's queue.
    loadQueue = loading.catch(() => {});
    return loading;
  }

  /** Fetch the selected style and replace the controlled document when both loads succeed. */
  async function selectScene(sceneUrl) {
    if (disposed) return;
    cancelPendingWork();
    const selectionRevision = ++revision;
    activeScene = sceneUrl;
    const request = new AbortController();
    sourceRequest = request;
    updateDocument({status: 'loading', message: '', readOnly: true});
    try {
      onSceneSelected(sceneUrl);
      const [source] = await Promise.all([
        fetchSource(sceneUrl, request.signal),
        enqueueScene(resolveSceneUrl(sceneUrl), undefined, selectionRevision)
      ]);
      if (disposed || revision !== selectionRevision) return;
      updateDocument({source: formatSource(source), status: 'ready', message: '', readOnly: false});
    } catch (error) {
      if (disposed || revision !== selectionRevision) return;
      updateDocument({status: 'error', message: String(error.message || error), readOnly: true});
    }
  }

  /** Apply the latest text after a quiet interval, preserving the selected style's base URL. */
  function editSource(source) {
    if (disposed || document.readOnly) return;
    clearTimeout(applyTimer);
    const editRevision = ++revision;
    updateDocument({source, status: 'editing', message: ''});
    applyTimer = setTimeout(async () => {
      try {
        const config = parseSource(source);
        const basePath = new URL('.', resolveSceneUrl(activeScene)).href;
        await enqueueScene(config, {base_path: basePath}, editRevision);
        if (disposed || revision !== editRevision) return;
        updateDocument({status: 'applied', message: ''});
      } catch (error) {
        if (disposed || revision !== editRevision) return;
        updateDocument({status: 'error', message: String(error.message || error)});
      }
    }, debounceMs);
  }

  /** Release requests and timers; repeated teardown is harmless. */
  function dispose() {
    if (disposed) return;
    disposed = true;
    ++revision;
    cancelPendingWork();
  }

  return {selectScene, editSource, dispose};
}

/**
 * Wait for initial renderer startup, and turn Scene's error-and-revert event
 * into an editor error even when its fallback load resolves successfully.
 */
export async function loadClassicEditorScene(scene, config, options, isDisposed) {
  if (scene.initializing) await scene.initializing;
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
    if (loadError) throw loadError;
  } finally {
    scene.unsubscribe(listener);
  }
}

/**
 * Recreate community panel definitions with a controlled value. Updating only
 * defaultValue does not update TextEditorPanel's mounted Monaco model. Replacing
 * the accordion in the mounted sidebar propagates props through both containers;
 * stable panel IDs preserve expansion state and the editor's model identity.
 */
export function createSceneEditorPanels({
  TextEditorPanel, AccordeonPanel, panels, document, jsonSchema, onValueChange
}) {
  const name = jsonSchema ? 'Scene JSON' : 'Scene YAML';
  const status = document.status === 'error'
    ? `error: ${document.message}`
    : document.status === 'ready'
      ? jsonSchema ? 'schema validated' : 'edit to apply'
      : document.status;
  const editorPanel = new TextEditorPanel({
    id: 'tangram-scene-editor',
    className: 'tangram-scene-editor',
    title: `${name} (${status})`,
    language: jsonSchema ? 'json' : 'plaintext',
    jsonSchema: jsonSchema || undefined,
    value: document.source,
    readOnly: document.readOnly,
    onValueChange
  });
  const accordionPanel = new AccordeonPanel({
    id: 'tangram-playground-panels',
    title: 'Playground panels',
    panels: [...panels, editorPanel]
  });
  return {editorPanel, accordionPanel};
}
