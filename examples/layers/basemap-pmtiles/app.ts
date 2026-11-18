// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {EXAMPLE_PANEL_STYLE} from '../../utils/panel-theme';
import {Deck, MapView, type MapViewState} from '@deck.gl/core';
import {BasemapLayer} from '@tangram.gl/basemap-layers';
import {
  ColumnPanel,
  MarkdownPanel,
  SettingsPanel,
  getValueAtPath,
  type SettingsSchema,
  type SettingsState
} from '@deck.gl-community/panels';
import {BoxPanelWidget} from '@deck.gl-community/widgets';

import {ARCHIVE_OPTIONS, type ArchiveOption} from './archives';
import {createRangeReadFetch, getReadsText, type ArchiveReads} from './range-reads';
import {fitViewState} from './view-bounds';

import '@deck.gl/widgets/stylesheet.css';

type ExampleSettings = {
  archive: {id: ArchiveOption['id']};
};

const SETTINGS_SCHEMA: SettingsSchema = {
  title: 'Settings',
  sections: [
    {
      id: 'settings',
      name: 'Settings',
      settings: [
        {
          name: 'archive.id',
          label: 'Archive',
          type: 'select',
          options: ARCHIVE_OPTIONS.map(option => ({label: option.label, value: option.id})),
          description: 'The `.pmtiles` file that the style source reads.'
        }
      ]
    }
  ]
};

/**
 * Draws a basemap from one `.pmtiles` file. The style source is `pmtiles://<file URL>`: the
 * header, the directories and the tiles are read from the file with HTTP range requests, and no
 * tile server is used.
 */
export function mountBasemapPMTilesExample(container: HTMLElement): () => void {
  const rootElement = createRoot(container);
  const settings: ExampleSettings = {archive: {id: ARCHIVE_OPTIONS[0].id}};
  const reads = new Map<string, ArchiveReads>();
  let readoutFrame = 0;
  // One `fetch` and one `loadOptions` object for the life of the example: the archive readers,
  // with the header and directories that they have read, are kept per `fetch`.
  const loadOptions = {
    fetch: createRangeReadFetch(reads, () => {
      readoutFrame ||= requestAnimationFrame(() => {
        readoutFrame = 0;
        syncInfoWidget();
      });
    })
  };

  const infoWidget = new BoxPanelWidget({
    style: EXAMPLE_PANEL_STYLE,
    id: 'basemap-pmtiles-info',
    placement: 'top-left',
    widthPx: 340,
    title: 'BasemapLayer',
    collapsible: true
  });

  const archive = getArchive(settings);
  // Each view state is moved inside the area of the archive (see `view-bounds.ts`).
  let size = {width: rootElement.clientWidth, height: rootElement.clientHeight};
  let viewState: MapViewState = fitView(getViewState(archive), archive);
  const deck = new Deck({
    parent: rootElement,
    views: new MapView({repeat: true}),
    controller: {dragRotate: false},
    initialViewState: viewState,
    onViewStateChange: ({viewState: next}) => (viewState = fitView(next, getArchive(settings))),
    onResize: nextSize => {
      size = nextSize;
      showView(fitView(viewState, getArchive(settings)));
    },
    layers: getLayers(archive),
    widgets: [infoWidget]
  });
  const attribution = createAttribution(rootElement.ownerDocument);
  rootElement.append(attribution);
  syncAttribution(archive);
  syncInfoWidget();

  return () => {
    cancelAnimationFrame(readoutFrame);
    deck.finalize();
    rootElement.remove();
    container.replaceChildren();
  };

  function fitView<ViewStateT extends MapViewState>(next: ViewStateT, option: ArchiveOption) {
    const flat = {...next, pitch: 0, bearing: 0};
    return size.width > 0 && size.height > 0
      ? fitViewState(flat, option.bounds, size.width, size.height)
      : flat;
  }

  function showView(next: MapViewState) {
    viewState = next;
    deck.setProps({initialViewState: viewState});
  }

  function getLayers(option: ArchiveOption) {
    return [new BasemapLayer({id: `basemap-${option.id}`, style: option.style, loadOptions})];
  }

  function syncAttribution(option: ArchiveOption) {
    attribution.innerHTML = option.attributionHtml;
  }

  function syncInfoWidget() {
    const option = getArchive(settings);
    infoWidget.setProps({
      panel: new ColumnPanel({
        id: 'basemap-pmtiles-panel',
        title: 'BasemapLayer',
        panels: [
          new MarkdownPanel({
            id: 'summary',
            title: '',
            markdown: [
              'A whole basemap from one `.pmtiles` file. The style source is',
              '`pmtiles://<file URL>`. Each tile is a byte range of the file, read with an',
              'HTTP range request. There is no tile server.',
              '',
              option.description
            ].join('\n')
          }),
          new MarkdownPanel({
            id: 'reads',
            title: '',
            markdown: getReadsText(reads.get(option.url), option.size).join('\n\n')
          }),
          new SettingsPanel({
            id: 'settings',
            label: 'Settings',
            schema: SETTINGS_SCHEMA,
            settings: settings as unknown as SettingsState,
            onSettingsChange: nextSettings => {
              const next = ARCHIVE_OPTIONS.find(
                candidate => candidate.id === getValueAtPath(nextSettings, 'archive.id')
              );
              if (next && next.id !== settings.archive.id) {
                settings.archive.id = next.id;
                showView(fitView(getViewState(next), next));
                deck.setProps({layers: getLayers(next)});
                syncAttribution(next);
                syncInfoWidget();
              }
            }
          })
        ]
      })
    });
  }
}

function getArchive(settings: ExampleSettings): ArchiveOption {
  return ARCHIVE_OPTIONS.find(option => option.id === settings.archive.id) || ARCHIVE_OPTIONS[0];
}

/** The view has no pitch and no bearing: the area that it shows is then a simple rectangle. */
function getViewState(option: ArchiveOption) {
  return {...option.view, pitch: 0, bearing: 0, maxPitch: 0};
}

function createRoot(container: HTMLElement): HTMLDivElement {
  const root = container.ownerDocument.createElement('div');
  root.style.position = 'relative';
  root.style.width = '100%';
  root.style.height = '100%';
  root.style.overflow = 'hidden';
  container.replaceChildren(root);
  return root;
}

function createAttribution(document: Document): HTMLDivElement {
  const attribution = document.createElement('div');
  attribution.className = 'basemap-attribution';
  Object.assign(attribution.style, {
    position: 'absolute',
    right: '0',
    bottom: '0',
    padding: '2px 6px',
    font: '12px/1.4 sans-serif',
    color: '#333',
    background: 'rgba(255, 255, 255, 0.8)'
  });
  return attribution;
}
