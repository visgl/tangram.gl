// Tangram
// SPDX-License-Identifier: MIT
// Copyright (c) 2013-2016 Brett Camper and Mapzen
// Copyright (c) 2026 vis.gl contributors

import {SCENE_OPTIONS} from './scene-catalog.js';

export function initializeClassicGui({
    scene,
    map,
    layer,
    Leaflet = window.L,
    Dat = window.dat,
    saveFile = window.saveAs
}) {
    var sceneKey = 'Simple';
    var sceneListener;

    function initializeGui() {
        // Add search control
        Leaflet.control.geocoder('ge-3d066b6b1c398181', {
            url: 'https://api.geocode.earth/v1',
            layers: 'coarse',
            expanded: true,
            markers: false,
            attribution: 'Geocoding by <a href="https://geocode.earth/" target="_blank">geocode.earth</a>'
        }).addTo(map);

        // Add GUI on scene load
        sceneListener = {
            load: function (msg) {
                addGUI();
            }
        };
        layer.scene.subscribe(sceneListener);
    }

    if (document.readyState === 'loading') {
        window.addEventListener('load', initializeGui, {once: true});
    }
    else {
        initializeGui();
    }

    var gui;
    function addGUI () {
        // Remove old GUI
        if (gui != null) {
            gui.destroy();
        }

        // Create GUI
        gui = new Dat.GUI({ autoPlace: true });
        gui.domElement.parentNode.style.zIndex = 10000;
        window.gui = gui;

        setLanguage(gui, scene);
        setCamera(gui, scene);
        setScene(gui);
        setScreenshot(gui, scene);
        setMediaRecorder(gui, scene);
        setFeatureDebug(gui);
        setLayers(gui, scene);
    }

    function setScene(gui) {
        var scenes = Object.fromEntries(SCENE_OPTIONS.map(option => [option.label, option.value]));

        Object.keys(scenes).forEach(function (s) { scenes[s] = JSON.stringify(scenes[s]); }); // need to stringify JSON for dat.gui :(

        sceneKey = Object.keys(scenes).filter(function (s) { return scenes[s] === JSON.stringify(scene.config_source); })[0]; // find scene from sample list
        if (sceneKey) {
            gui.scene = scenes[sceneKey];
        }
        else {
            gui.scene = {};
        }

        gui.add(gui, 'scene', scenes).onChange(function(value) {
            sceneKey = Object.keys(scenes).filter(function(s){ return scenes[s] === value })[0]; // find scene from sample list
            value = JSON.parse(value); // need to stringify JSON for dat.gui :(
            scene.load(value);
        });
    }

    function setLanguage(gui, scene){
        var langs = {
            '(default)': null,
            'English': 'en',
            'Russian': 'ru',
            'Japanese': 'ja',
            'German': 'de',
            'French': 'fr',
            'Arabic': 'ar',
            'Hindi': 'hi',
            'Spanish': 'es'
        };

        // only add if scene supports language
        if (scene.config.global.language !== undefined || scene.config.global.ux_language !== undefined) {
            gui.language = 'en';
            scene.config.global.language = gui.language;
            scene.config.global.ux_language = gui.language;
            gui.add(gui, 'language', langs).onChange(function(value) {
                scene.config.global.language = value;    // for bundled demos
                scene.config.global.ux_language = value; // for Nextzen basemaps
                scene.updateConfig();
            });
        }
    }

    function setCamera(gui, scene){
        // Only add if scene has all camera types
        var cameras = scene.config.cameras;
        if (cameras.perspective && cameras.isometric && cameras.flat) {
            var camera_types = {
                'Flat': 'flat',
                'Perspective': 'perspective',
                'Isometric': 'isometric'
            };

            gui.camera = scene.getActiveCamera();
            gui.add(gui, 'camera', camera_types).onChange(function(value) {
                scene.setActiveCamera(value);
            });
        }
    }

    function setScreenshot(gui, scene){
        // Take a screenshot and save to file
        gui.screenshot = function () {
            return scene.screenshot().then(function(screenshot) {
                // uses FileSaver.js: https://github.com/eligrey/FileSaver.js/
                saveFile(screenshot.blob, 'tangram-' + (+new Date()) + '.png');
            });
        };
        gui.add(gui, 'screenshot');
    }

    function setMediaRecorder(gui, scene){
        // Take a video capture and save to file
        if (typeof window.MediaRecorder == 'function') {
            gui.video = function () {
                if (!gui.video_capture) {
                    if (scene.startVideoCapture()) {
                        gui.video_capture = true;
                        gui.video_button.name('stop video');
                    }
                }
                else {
                    return scene.stopVideoCapture().then(function(video) {
                        gui.video_capture = false;
                        gui.video_button.name('capture video');
                        saveFile(video.blob, 'tangram-video-' + (+new Date()) + '.webm');
                    });
                }
            };
            gui.video_button = gui.add(gui, 'video');
            gui.video_button.name('capture video');
            gui.video_capture = false;
        }
    }

    function setLayers(gui, scene){
        var layer_gui = gui.addFolder('Layers');
        var layer_controls = {};
        var layers = scene.config.layers;

        for (var key in layers){
            setOnChange(key);
        }
        function setOnChange(key) {
            var layer = layers[key];
            if (!layer) {
                return;
            }

            layer_controls[key] = !(layer.enabled == false);
            layer_gui.add(layer_controls, key)
                .onChange(function(value) {
                    layer.enabled = value;
                    scene.updateConfig();
                });

        }
    }

    function setFeatureDebug(gui) {
        gui.debug = scene.introspection;
        gui.add(gui, 'debug').onChange(function(value) {
            scene.setIntrospection(value);
        });
    }

    return function destroyClassicGui() {
        window.removeEventListener('load', initializeGui);
        if (sceneListener) {
            layer.scene.unsubscribe(sceneListener);
        }
        if (gui) {
            gui.destroy();
            gui = null;
        }
        window.gui = null;
    };
}
