// Tangram
// SPDX-License-Identifier: MIT
// Copyright (c) 2013-2016 Brett Camper and Mapzen

import Scene from '../src/scene/classic_scene';

let container = document.createElement('div');
container.style.width = '250px';
container.style.height = '250px';
document.body.appendChild(container);

// Use test-specific worker build for web workers
window.Tangram = window.Tangram || {};
window.Tangram.workerURL = new URL('../build/worker.test.js', import.meta.url).href;

// Helper for loading scene
window.makeScene = function (options) {
    options = options || {};

    options.disableRenderLoop = options.disableRenderLoop || true;
    options.container = options.container || container;
    options.logLevel =  options.logLevel || 'info';

    return new Scene(
        options.config || new URL('./fixtures/sample-scene.yaml', import.meta.url).href,
        options
    );

};
