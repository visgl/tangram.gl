// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {DEFAULT_SCENE, SCENE_OPTIONS} from './scene-catalog.js';
import {createMonacoEnvironment} from './monaco-workers.js';

function configureMonacoWorkers() {
  if (window.MonacoEnvironment) {
    return;
  }
  const workerBaseUrl = new URL(
    window.tangramClassicBaseUrl || './',
    document.baseURI
  ).href;
  window.MonacoEnvironment = createMonacoEnvironment(workerBaseUrl);
}

configureMonacoWorkers();

// Match the locally built workers instead of allowing the CDN's semver
// resolution to drift independently from the editor's worker protocol.
const {
  AccordeonPanel,
  PanelManager,
  SettingsPanel,
  SidebarPanelContainer,
  TextEditorPanel
} = await import('https://esm.sh/@deck.gl-community/panels@9.4.0-alpha.2?bundle&deps=monaco-editor@0.53.0');

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

async function startSettingsPanel() {
  if (!window.scene || !window.layer) {
    return;
  }

  const settings = createSettings();
  let selectedScene = settings.scene;
  let activeScene = settings.scene;
  const sceneSource = await fetchSceneSource(settings.scene);
  const styleSchema = await fetchStyleSchema();
  const editorSource = styleSchema ? formatSceneAsJson(sceneSource) : sceneSource;
  const panelManager = new PanelManager({parentElement: createPanelHost()});
  const examplePanel = new SettingsPanel({
    id: 'tangram-example-selector',
    schema: EXAMPLE_SCHEMA,
    settings,
    onSettingsChange: nextSettings => {
      if (nextSettings.scene && nextSettings.scene !== selectedScene) {
        selectedScene = nextSettings.scene;
        sidebarPanel.setProps({title: 'Tangram playground'});
        settings.scene = nextSettings.scene;
        activeScene = nextSettings.scene;
        window.tangramUpdateCartoBasemap?.(nextSettings.scene);
        window.scene.load(resolveSceneUrl(nextSettings.scene));
        fetchSceneSource(nextSettings.scene).then(nextSceneSource => {
          if (activeScene === nextSettings.scene) {
            editorPanel.setProps({
              title: styleSchema ? 'Scene JSON (schema validated)' : 'Scene YAML (edit to apply)',
              language: styleSchema ? 'json' : 'plaintext',
              jsonSchema: styleSchema || undefined,
              defaultValue: styleSchema ? formatSceneAsJson(nextSceneSource) : nextSceneSource
            });
          }
        });
        const nextUrl = new URL(window.location.href);
        nextUrl.searchParams.set('scene', nextSettings.scene);
        window.history.replaceState(null, '', nextUrl);
      }
    }
  });
  const settingsPanel = new SettingsPanel({
    id: 'tangram-settings',
    schema: SETTINGS_SCHEMA,
    settings,
    onSettingsChange: nextSettings => {
      if (nextSettings.camera && nextSettings.camera !== settings.camera) {
        settings.camera = nextSettings.camera;
        if (window.scene.config?.cameras?.[nextSettings.camera]) {
          window.scene.setActiveCamera(nextSettings.camera);
        }
      }
      if (typeof nextSettings.debug === 'boolean' && nextSettings.debug !== settings.debug) {
        settings.debug = nextSettings.debug;
        window.scene.setIntrospection(nextSettings.debug);
      }
    }
  });

  const editorPanel = new TextEditorPanel({
    id: 'tangram-scene-editor',
    className: 'tangram-scene-editor',
    title: styleSchema ? 'Scene JSON (schema validated)' : 'Scene YAML (edit to apply)',
    language: styleSchema ? 'json' : 'plaintext',
    jsonSchema: styleSchema || undefined,
    defaultValue: editorSource,
    onValueChange: applyEditedScene
  });
  const accordionPanel = new AccordeonPanel({
    id: 'tangram-playground-panels',
    title: 'Playground panels',
    panels: [examplePanel, settingsPanel, editorPanel]
  });
  const sidebarPanel = new SidebarPanelContainer({
    id: 'tangram-playground-sidebar',
    title: window.tangramRequestedSceneWithoutKey
      ? 'Tangram playground — Nextzen key required'
      : 'Tangram playground',
    panel: accordionPanel,
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
  }
  // PanelManager normally receives this notification from Deck's redraw
  // lifecycle. The standalone classic example has no Deck instance, so make
  // the initial placement pass explicitly and keep it current on resize.
  const updatePanelLayout = () => {
    panelManager.onRedraw({viewports: [], layers: []});
  };
  updatePanelLayout();
  window.addEventListener('resize', updatePanelLayout);
  window.settingsPanel = settingsPanel;
  window.settingsPanelManager = panelManager;
  window.sceneEditorPanel = editorPanel;
  window.tangramPlaygroundSidebar = sidebarPanel;
  window.addEventListener(
    'beforeunload',
    () => {
      window.removeEventListener('resize', updatePanelLayout);
      panelManager.finalize();
    },
    {once: true}
  );

  let applyTimer;
  function applyEditedScene(source) {
    window.clearTimeout(applyTimer);
    applyTimer = window.setTimeout(() => {
      try {
        const config = window.Tangram.debug.yaml.safeLoad(source);
        const sceneUrl = new URL(resolveSceneUrl(activeScene), window.location.href);
        window.scene.load(config, {base_path: new URL('.', sceneUrl).href});
        editorPanel.setProps({
          title: styleSchema ? 'Scene JSON (applied)' : 'Scene YAML (applied)'
        });
      } catch (error) {
        editorPanel.setProps({
          title: `${styleSchema ? 'Scene JSON' : 'Scene YAML'} (error: ${error.message})`
        });
      }
    }, 400);
  }

  window.tangramClassicSettingsCleanup = () => {
    window.clearTimeout(applyTimer);
    window.removeEventListener('resize', updatePanelLayout);
    panelManager.finalize();
    host.remove();
    window.tangramClassicSettingsCleanup = null;
  };
}

async function fetchSceneSource(sceneUrl) {
  try {
    const response = await fetch(resolveSceneUrl(sceneUrl));
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.text();
  } catch (error) {
    return `# Unable to load scene YAML: ${error.message}`;
  }
}

async function fetchStyleSchema() {
  const schemaUrl =
    window.tangramStyleSchemaUrl ||
    new URL('../../modules/tangram-renderer/dist/tangram-style.schema.json', document.baseURI).href;
  try {
    const response = await fetch(schemaUrl);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.json();
  } catch (error) {
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

if (document.readyState === 'loading') {
  window.addEventListener('load', startSettingsPanel, {once: true});
} else {
  startSettingsPanel();
}
