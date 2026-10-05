// Tangram
// SPDX-License-Identifier: MIT
// Copyright (c) 2013-2016 Brett Camper and Mapzen
// Copyright (c) 2026 vis.gl contributors

import Tangram from '../../modules/tangram-renderer/dist/tangram.debug.mjs';
import {leafletLayer} from './leaflet-layer.js';
import {initializeApiKey} from './app/key.js';
import {initializeUrlSync} from './app/url.js';
import {DEFAULT_SCENE} from './app/scene-catalog.js';

/*
    Hello source-viewers!
    We're glad you're interested in how Tangram can be used to make amazing maps!
    - The Tangram team
*/

export function createClassicDemo() {
    if (window.tangramClassicCancelled) {
        return null;
    }

    var scene_url = window.tangramClassicScene || DEFAULT_SCENE;
    var nextzen_scenes = [
        'scene.yaml',
        'styles/crosshatch.zip'
    ];

    // optionally override scene URL
    if ('URLSearchParams' in window) {
        var params = new URLSearchParams(window.location.search);
        if (params.get('scene')) {
            scene_url = params.get('scene');
            if (scene_url[0] === '{') {
                scene_url = JSON.parse(scene_url); // parse JSON-encoded scenes
            }
        }

        // Keep direct links usable when they target a historical scene whose
        // vector or terrain sources require a caller-provided Nextzen key.
        if (!params.get('api_key') && nextzen_scenes.indexOf(scene_url) > -1) {
            window.tangramRequestedSceneWithoutKey = scene_url;
            scene_url = 'styles/local-basemap.yaml';
        }
    }

    // The integrated Docusaurus route does not end with a slash, so resolve
    // classic scene assets against the copied example directory explicitly.
    if (typeof scene_url === 'string' && !/^[a-z][a-z\d+\-.]*:/i.test(scene_url)) {
        scene_url = new URL(
            scene_url,
            new URL(window.tangramClassicBaseUrl || './', document.baseURI).href
        ).href;
    }

    // Create Tangram as a Leaflet layer
    var layer = leafletLayer({
        scene: scene_url,
        events: {
            hover: onHover,     // hover event (defined below)
            click: onClick      // click event (defined below)
        },
        debug: {
            // layer_stats: true // enable to collect detailed layer stats, access w/`scene.debug.layerStats()`
            // wireframe: true // enable for wireframe rendering mode
        },
        logLevel: 'debug'
    });

    // Create a Leaflet map
    var map = L.map(window.tangramClassicMapId || 'map', {
        maxZoom: 22,
        zoomSnap: 0,
        keyboard: false
    });

    // Useful events to subscribe to
    layer.scene.subscribe({
        load: function (msg) {
            // scene was loaded
        },
        update: function (msg) {
            // scene updated
        },
        pre_update: function (will_render) {
            // before scene update
            // zoom in/out if up/down arrows pressed
            var zoom_step = 0.03;
            if (key.isPressed('up')) {
                map._move(map.getCenter(), map.getZoom() + zoom_step);
                map._moveEnd(true);
            }
            else if (key.isPressed('down')) {
                map._move(map.getCenter(), map.getZoom() - zoom_step);
                map._moveEnd(true);
            }
        },
        post_update: function (will_render){
            // after scene update
        },
        view_complete: function (msg) {
            // new set of map tiles was rendered
        },
        error: function (msg) {
            // on error
        },
        warning: function (msg) {
            // on warning
        }
    });

    // Feature selection
    var tooltip = L.tooltip();
    layer.bindTooltip(tooltip);
    map.on('zoom', function(){ layer.closeTooltip() }); // close tooltip when zooming

    function onHover (selection) {
        var feature = selection.feature;
        if (feature) {
            if (selection.changed) {
                var info;
                if (scene.introspection) {
                    info = getFeaturePropsHTML(feature);
                }
                else {
                    var name = feature.properties.name || feature.properties.kind ||
                        (Object.keys(feature.properties).length+' properties');
                    name = '<b>'+name+'</b>';
                    name += '<br>(click for details)';
                    name = '<span class="labelInner">' + name + '</span>';
                    info = name;
                }

                if (info) {
                    tooltip.setContent(info);
                }
            }
            layer.openTooltip(selection.leaflet_event.latlng);
        }
        else {
            layer.closeTooltip();
        }
    }

    function onClick(selection) {
        // Link to edit in Open Street Map on alt+click (opens popup window)
        if (key.alt) {
            var center = map.getCenter();
            var url = 'https://www.openstreetmap.org/edit?#map=' + map.getZoom() + '/' + center.lat + '/' + center.lng;
            window.open(url, '_blank');
            return;
        }

        if (scene.introspection) {
            return; // click doesn't show additional details when introspection is on
        }

        // Show feature details
        var feature = selection.feature;
        if (feature) {
            var info = getFeaturePropsHTML(feature);
            tooltip.setContent(info);
            layer.openTooltip(selection.leaflet_event.latlng);
        }
        else {
            layer.closeTooltip();
        }
    }

    // Get an HTML fragment with feature properties
    function getFeaturePropsHTML (feature) {
        var props = ['name', 'kind', 'kind_detail', 'id']; // show these properties first if available
        Object.keys(feature.properties) // show rest of proeprties alphabetized
            .sort()
            .forEach(function(p) {
                if (props.indexOf(p) === -1) {
                    props.push(p);
                }
            });

        var info = '<div class="featureTable">';
        props.forEach(function(p) {
            if (feature.properties[p]) {
                info += '<div class="featureRow"><div class="featureCell"><b>' + p + '</b></div>' +
                    '<div class="featureCell">' + feature.properties[p] + '</div></div>';
            }
        });

        // data source and tile info
        info += '<div class="featureRow"><div class="featureCell"><b>tile</b></div>' +
            '<div class="featureCell">' + feature.tile.coords.key + '</div></div>';
        info += '<div class="featureRow"><div class="featureCell"><b>source name</b></div>' +
            '<div class="featureCell">' + feature.source_name + '</div></div>';
        info += '<div class="featureRow"><div class="featureCell"><b>source layer</b></div>' +
            '<div class="featureCell">' + feature.source_layer + '</div></div>';

        // scene layers
        info += '<div class="featureRow"><div class="featureCell"><b>scene layers</b></div>' +
                '<div class="featureCell">' + feature.layers.join('<br>') + '</div></div>';
        info += '</div>';
        return info;
    }

    /*** Map ***/

    window.map = map;
    window.layer = layer;
    window.scene = layer.scene;
    window.Tangram = Tangram;

    const destroyApiKey = initializeApiKey({scene: layer.scene});
    const destroyUrlSync = initializeUrlSync({map, layer, sceneUrl: scene_url});

    function initializeClassicDemo() {
        layer.addTo(map);
        layer.bringToFront();
    }

    if (document.readyState === 'loading') {
        window.addEventListener('load', initializeClassicDemo, {once: true});
    } else {
        initializeClassicDemo();
    }

    function destroyClassicDemo() {
        window.removeEventListener('load', initializeClassicDemo);
        destroyApiKey();
        destroyUrlSync();
        window.tangramClassicSettingsCleanup?.();
        map.remove();
        window.map = null;
        window.layer = null;
        window.scene = null;
        window.tangramClassicDestroy = null;
    }

    window.tangramClassicDestroy = destroyClassicDemo;
    return {map, layer, scene: layer.scene, destroy: destroyClassicDemo};
}

createClassicDemo();
