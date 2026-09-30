// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

let workerURL: string | undefined;

/** Installs the bundled worker URL without exposing a global Tangram object. */
export function setWorkerURL(url: string): void {
    workerURL = url;
}

/** Returns the core bundle's default worker URL; explicit scene options take precedence. */
export function getWorkerURL(): string | undefined {
    return workerURL;
}
