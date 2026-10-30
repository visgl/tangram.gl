// Tangram
// SPDX-License-Identifier: MIT
// Copyright (c) 2013-2016 Brett Camper and Mapzen
// Copyright (c) 2026 vis.gl contributors

export type ThreadState = {
  is_worker: boolean;
  is_main: boolean;
};

// Node/SSR is neither a browser main thread nor a Web Worker. In particular,
// do not install worker-only global shims while a server imports the package.
const isMain = typeof window !== 'undefined' && typeof Window !== 'undefined' &&
  typeof HTMLDocument !== 'undefined' && window instanceof Window && window.document instanceof HTMLDocument;
const isWorker = typeof WorkerGlobalScope !== 'undefined' && globalThis instanceof WorkerGlobalScope;
const Thread: ThreadState = {is_worker: isWorker, is_main: isMain};

if (isWorker) {
  // Patch for third-party libraries that require these globals to be present, specifically
  // FontFaceObserver. This allows that library to load on worker threads.
  const workerWindow = {document: {}};
  Reflect.set(globalThis, 'window', workerWindow);
  Reflect.set(globalThis, 'document', workerWindow.document);
}

export default Thread;
