// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {DEFAULT_SCENE, SCENE_OPTIONS, getSceneOverview} from './scene-catalog.js';
import {createClassicPlaygroundRenderer} from './playground-renderer.js';

const SETTINGS_SCHEMA = {
  title: 'Settings',
  sections: [{
    id: 'scene-settings', name: 'Camera and diagnostics', initiallyCollapsed: false,
    settings: [{
      name: 'camera', label: 'Camera', type: 'select',
      options: [
        {label: 'Perspective', value: 'perspective'},
        {label: 'Flat', value: 'flat'},
        {label: 'Isometric', value: 'isometric'}
      ],
      defaultValue: 'perspective', persist: 'none'
    }, {
      name: 'debug', label: 'Debug inspection', type: 'boolean',
      defaultValue: false, persist: 'none'
    }]
  }]
};

/** Mount the shared community playground without transferring ownership of the scene. */
export async function startSettingsPanel({createCommunityPlayground, createCommunitySettingsPanel}) {
  if (!window.scene || !window.layer) return;
  const scene = window.scene;
  const initialRequest = new AbortController();
  let disposed = false;
  let host;
  let playground;
  let renderer;
  let statusElement;
  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    initialRequest.abort();
    window.removeEventListener('beforeunload', cleanup);
    playground?.finalize();
    renderer?.finalize();
    host?.remove();
    if (window.tangramPlayground === playground) delete window.tangramPlayground;
    if (window.tangramClassicSettingsCleanup === cleanup) window.tangramClassicSettingsCleanup = null;
  };
  window.tangramClassicSettingsCleanup = cleanup;
  window.addEventListener('beforeunload', cleanup, {once: true});
  const selectedScene = window.tangramRequestedSceneWithoutKey
    ? 'styles/local-basemap.yaml'
    : new URLSearchParams(window.location.search).get('scene') || window.tangramClassicScene || DEFAULT_SCENE;
  const resolveSceneUrl = sceneUrl => new URL(sceneUrl,
    new URL(window.tangramClassicBaseUrl || './', document.baseURI)).href;
  const fetchSceneSource = async sceneUrl => {
    const response = await fetch(resolveSceneUrl(sceneUrl), {signal: initialRequest.signal});
    if (!response.ok) throw new Error(sceneUrl + ': HTTP ' + response.status);
    return response.text();
  };
  try {
    // Generic Playground accepts concrete documents. Preload the small local
    // style files, not their remote imports or tiles, before mounting its cards.
    const sceneNames = [...new Set([selectedScene, ...SCENE_OPTIONS.map(option => option.value)])];
    const [sources, styleSchema] = await Promise.all([
      Promise.all(sceneNames.map(async name => [name, await fetchSceneSource(name)])),
      fetchStyleSchema(initialRequest.signal)
    ]);
    if (disposed) return;
    const templates = Object.fromEntries(sources.map(([name, source]) => [name,
      styleSchema ? JSON.stringify(window.Tangram.debug.yaml.safeLoad(source), null, 2) : source
    ]));
    host = document.createElement('div');
    host.className = 'classic-settings-host';
    const parent = window.tangramClassicEmbedded
      ? document.getElementById('classic-playground-frame') : document.body;
    parent.append(host);
    host.style.position = window.tangramClassicEmbedded ? 'absolute' : 'fixed';
    const settings = {camera: 'perspective', debug: false};
    const settingsPanel = createCommunitySettingsPanel({
      id: 'tangram-settings', schema: SETTINGS_SCHEMA, settings,
      onSettingsChange: next => {
        if (next.camera && next.camera !== settings.camera) {
          settings.camera = next.camera;
          if (scene.config?.cameras?.[next.camera]) scene.setActiveCamera(next.camera);
        }
        if (typeof next.debug === 'boolean' && next.debug !== settings.debug) {
          settings.debug = next.debug;
          scene.setIntrospection(next.debug);
        }
      }
    });
    renderer = createClassicPlaygroundRenderer({scene, resolveSceneUrl, mapElement: document.getElementById('map')});
    // Create status before construction: startup synchronously invokes observers.
    statusElement = document.createElement('div');
    statusElement.className = 'classic-playground-status';
    statusElement.setAttribute('role', 'status');
    statusElement.setAttribute('aria-live', 'polite');
    let initialTemplate = true;
    playground = createCommunityPlayground({
      parentElement: host, templates, initialTemplate: selectedScene,
      templateMetadata: Object.fromEntries(SCENE_OPTIONS.map(option => [option.value, {
        title: option.label,
        description: option.value.includes('local-') || option.value.includes('preview')
          ? 'Local preview fixture.' : 'Editable Tangram style.'
      }])),
      editorTitle: styleSchema ? 'Style JSON' : 'Style YAML',
      examplesTitle: 'Select Style', sidebarSide: 'right', sidebarWidthPx: 430,
      language: styleSchema ? 'json' : 'plaintext', jsonSchema: styleSchema,
      parse: text => window.Tangram.debug.yaml.safeLoad(text),
      panels: [settingsPanel], renderer,
      onTemplateChange: sceneUrl => {
        const overview = getSceneOverview(sceneUrl);
        // Bootstrap already applied the initial URL/hash camera, including
        // authored Albers views. Only explicit card selections reset it.
        if (overview && !initialTemplate) window.map?.setView(overview.slice(1, 3), overview[0]);
        initialTemplate = false;
        window.tangramUpdateCartoBasemap?.(sceneUrl);
        const nextUrl = new URL(window.location.href);
        nextUrl.searchParams.set('scene', sceneUrl);
        window.history.replaceState(null, '', nextUrl);
      },
      onStatusChange: status => {
        statusElement.dataset.status = status;
        statusElement.textContent = status === 'loading' ? 'Applying style…' : status === 'ready' ? 'Style applied' : 'Style error';
      },
      onError: error => {statusElement.textContent = 'Style error: ' + error.message;}
    });
    host.append(statusElement);
    window.map?.invalidateSize?.();
    window.tangramPlayground = playground;
  } catch (error) {
    if (!disposed) console.warn('Unable to start Tangram editor: ' + error.message);
    cleanup();
  }
}

/** Load the exported renderer schema; YAML remains editable if it is unavailable. */
async function fetchStyleSchema(signal) {
  const schemaUrl = window.tangramStyleSchemaUrl ||
    new URL('../../modules/tangram-renderer/dist/tangram-style.schema.json', document.baseURI).href;
  try {
    const response = await fetch(schemaUrl, {signal});
    if (!response.ok) throw new Error('HTTP ' + response.status);
    return await response.json();
  } catch (error) {
    if (signal.aborted) throw error;
    console.warn('Unable to load Tangram style schema: ' + error.message);
    return null;
  }
}
