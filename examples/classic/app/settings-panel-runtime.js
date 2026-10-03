// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {DEFAULT_SCENE, SCENE_OPTIONS, getSceneOverview} from './scene-catalog.js';
import {createSceneEditorController, createSceneEditorPanels, loadClassicEditorScene} from './scene-editor.js';

const EXAMPLE_SCHEMA = {
  title: 'Example',
  sections: [
    {
      id: 'example',
      name: 'Choose a scene',
      initiallyCollapsed: false,
      settings: [
        {
          name: 'scene',
          label: 'Select style',
          type: 'select',
          description: 'TRON and Crosshatch use live OpenFreeMap vector tiles. Local previews are separate choices.',
          options: SCENE_OPTIONS.map(option => ({
            label: option.label,
            value: option.value,
            description: 'Runs without a Nextzen key.'
          })),
          defaultValue: DEFAULT_SCENE,
          persist: 'none'
        },
      ]
    }
  ]
};

const SETTINGS_SCHEMA = {
  title: 'Scene settings',
  sections: [
    {
      id: 'scene-settings',
      name: 'Camera and diagnostics',
      initiallyCollapsed: false,
      settings: [
        {
          name: 'camera',
          label: 'Camera',
          type: 'select',
          options: [
            {label: 'Perspective', value: 'perspective'},
            {label: 'Flat', value: 'flat'},
            {label: 'Isometric', value: 'isometric'}
          ],
          defaultValue: 'perspective',
          persist: 'none'
        },
        {
          name: 'debug',
          label: 'Debug inspection',
          type: 'boolean',
          defaultValue: false,
          persist: 'none'
        }
      ]
    }
  ]
};

function createSettings() {
  const sceneUrl = window.tangramRequestedSceneWithoutKey
    ? 'styles/local-basemap.yaml'
    : new URLSearchParams(window.location.search).get('scene') || window.tangramClassicScene || DEFAULT_SCENE;
  return {scene: sceneUrl, camera: 'perspective', debug: false};
}

function resolveSceneUrl(sceneUrl) {
  if (typeof sceneUrl !== 'string' || /^[a-z][a-z\d+\-.]*:/i.test(sceneUrl)) {
    return sceneUrl;
  }
  const classicBaseUrl = new URL(
    window.tangramClassicBaseUrl || './',
    document.baseURI
  ).href;
  return new URL(sceneUrl, classicBaseUrl).href;
}

function createPanelHost() {
  const host = document.createElement('div');
  host.className = 'classic-settings-host';
  const parentElement = window.tangramClassicEmbedded
    ? document.getElementById('classic-playground-frame')
    : document.body;
  // The classic map is made entirely from absolutely positioned elements, so
  // the body has no normal-flow height for percentage sizing to resolve
  // against. Use the viewport as the panel host's containing block and let
  // PanelManager size its placement containers from it.
  host.style.position = window.tangramClassicEmbedded ? 'absolute' : 'fixed';
  host.style.inset = '0';
  host.style.width = window.tangramClassicEmbedded ? '100%' : '100vw';
  host.style.height = window.tangramClassicEmbedded ? '100%' : '100vh';
  parentElement.appendChild(host);
  return host;
}

/** Mount the classic example's community panels with cancellable, idempotent teardown. */
export async function startSettingsPanel({
  AccordeonPanel, PanelManager, SettingsPanel, SidebarPanelContainer, TextEditorPanel
}) {
  if (!window.scene || !window.layer) {
    return;
  }
  const scene = window.scene;
  const initialRequest = new AbortController();
  let disposed = false;
  let host;
  let panelManager;
  let editorController;
  let updatePanelLayout;
  let editorPanel;
  let settingsPanel;
  let sidebarPanel;
  // Register teardown before the first asynchronous request. Navigating away
  // during startup must not leave a late-mounted sidebar behind.
  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    initialRequest.abort();
    editorController?.dispose();
    window.removeEventListener('resize', updatePanelLayout);
    window.removeEventListener('beforeunload', cleanup);
    panelManager?.finalize();
    host?.remove();
    if (window.settingsPanelManager === panelManager) {
      delete window.settingsPanel;
      delete window.settingsPanelManager;
      delete window.sceneEditorPanel;
      delete window.tangramPlaygroundSidebar;
    }
    if (window.tangramClassicSettingsCleanup === cleanup) {
      window.tangramClassicSettingsCleanup = null;
    }
  };
  window.tangramClassicSettingsCleanup = cleanup;
  window.addEventListener('beforeunload', cleanup, {once: true});
  const settings = createSettings();
  let selectedScene = settings.scene;
  let sceneSource;
  let styleSchema;
  try {
    [sceneSource, styleSchema] = await Promise.all([
      fetchSceneSource(settings.scene, initialRequest.signal),
      fetchStyleSchema(initialRequest.signal)
    ]);
  } catch (error) {
    if (!disposed) console.warn(`Unable to start Tangram editor: ${error.message}`);
    cleanup();
    return;
  }
  if (disposed) return;
  const editorSource = styleSchema ? formatSceneAsJson(sceneSource) : sceneSource;
  host = createPanelHost();
  panelManager = new PanelManager({parentElement: host});
  const examplePanel = new SettingsPanel({
    id: 'tangram-example-selector',
    schema: EXAMPLE_SCHEMA,
    settings,
    onSettingsChange: nextSettings => {
      if (nextSettings.scene && nextSettings.scene !== selectedScene) {
        selectedScene = nextSettings.scene;
        settings.scene = nextSettings.scene;
        editorController.selectScene(nextSettings.scene);
      }
    }
  });
  settingsPanel = new SettingsPanel({
    id: 'tangram-settings',
    schema: SETTINGS_SCHEMA,
    settings,
    onSettingsChange: nextSettings => {
      if (nextSettings.camera && nextSettings.camera !== settings.camera) {
        settings.camera = nextSettings.camera;
        if (scene.config?.cameras?.[nextSettings.camera]) {
          scene.setActiveCamera(nextSettings.camera);
        }
      }
      if (typeof nextSettings.debug === 'boolean' && nextSettings.debug !== settings.debug) {
        settings.debug = nextSettings.debug;
        scene.setIntrospection(nextSettings.debug);
      }
    }
  });

  editorController = createSceneEditorController({
    initialScene: settings.scene,
    initialSource: editorSource,
    fetchSource: fetchSceneSource,
    formatSource: source => styleSchema ? formatSceneAsJson(source) : source,
    parseSource: source => window.Tangram.debug.yaml.safeLoad(source),
    loadScene: (config, options) => loadClassicEditorScene(scene, config, options, () => disposed),
    resolveSceneUrl,
    onSceneSelected: sceneUrl => {
      const overview = getSceneOverview(sceneUrl);
      if (overview) window.map?.setView(overview.slice(1, 3), overview[0]);
      sidebarPanel.setProps({title: 'Tangram playground'});
      window.tangramUpdateCartoBasemap?.(sceneUrl);
      const nextUrl = new URL(window.location.href);
      nextUrl.searchParams.set('scene', sceneUrl);
      window.history.replaceState(null, '', nextUrl);
    },
    onDocumentChange: document => {
      const nextPanels = createPanels(document);
      editorPanel = nextPanels.editorPanel;
      sidebarPanel.setProps({panel: nextPanels.accordionPanel});
      window.sceneEditorPanel = editorPanel;
    }
  });
  function createPanels(document) {
    return createSceneEditorPanels({
      TextEditorPanel, AccordeonPanel, panels: [examplePanel, settingsPanel],
      document, jsonSchema: styleSchema,
      onValueChange: editorController.editSource
    });
  }
  const initialPanels = createPanels({source: editorSource, status: 'ready', readOnly: false});
  editorPanel = initialPanels.editorPanel;
  sidebarPanel = new SidebarPanelContainer({
    id: 'tangram-playground-sidebar',
    title: window.tangramRequestedSceneWithoutKey
      ? 'Tangram playground — Nextzen key required'
      : 'Tangram playground',
    panel: initialPanels.accordionPanel,
    side: 'right',
    placement: 'top-right',
    widthPx: 430,
    triggerLabel: 'Open Tangram controls',
    button: true,
    defaultOpen: true,
    viewportMarginPx: 12
  });

  panelManager.setProps({components: [sidebarPanel]});
  // AccordeonPanel intentionally starts with all sections collapsed. Keep the
  // style selector visible and let the editor consume the remaining height.
  const accordionButtons = panelManager.parentElement.querySelectorAll(
    '[data-sidebar-shell] section button'
  );
  for (const button of [accordionButtons[0], accordionButtons[accordionButtons.length - 1]]) {
    button?.dispatchEvent(new PointerEvent('pointerdown', {bubbles: true}));
    // The accordion batches state updates. Let the first expansion render so
    // the editor's toggle does not overwrite it with a stale empty ID list.
    await Promise.resolve();
    if (disposed) return;
  }
  // PanelManager normally receives this notification from Deck's redraw
  // lifecycle. The standalone classic example has no Deck instance, so make
  // the initial placement pass explicitly and keep it current on resize.
  updatePanelLayout = () => {
    panelManager.onRedraw({viewports: [], layers: []});
  };
  updatePanelLayout();
  window.addEventListener('resize', updatePanelLayout);
  window.settingsPanel = settingsPanel;
  window.settingsPanelManager = panelManager;
  window.sceneEditorPanel = editorPanel;
  window.tangramPlaygroundSidebar = sidebarPanel;
}

async function fetchSceneSource(sceneUrl, signal) {
  const response = await fetch(resolveSceneUrl(sceneUrl), {signal});
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return await response.text();
}

async function fetchStyleSchema(signal) {
  const schemaUrl =
    window.tangramStyleSchemaUrl ||
    new URL('../../modules/tangram-renderer/dist/tangram-style.schema.json', document.baseURI).href;
  try {
    const response = await fetch(schemaUrl, {signal});
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.json();
  } catch (error) {
    if (signal.aborted) throw error;
    console.warn(`Unable to load Tangram style schema: ${error.message}`);
    return null;
  }
}

function formatSceneAsJson(source) {
  try {
    const config = window.Tangram.debug.yaml.safeLoad(source);
    return JSON.stringify(config, null, 2);
  } catch {
    return source;
  }
}
