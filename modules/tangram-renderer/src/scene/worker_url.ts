// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

let workerURL: string | undefined;
const taskWorkerURLs = new Set<string>();

/** Mark a renderer-generated worker as supporting the scene task protocol. */
export function registerTaskWorkerURL(url: string): void {
    taskWorkerURLs.add(url);
}

/** Whether a URL is known to identify a task-capable renderer-generated worker. */
export function isTaskWorkerURL(url: string): boolean {
    return taskWorkerURLs.has(url);
}

/** Installs the bundled worker URL without exposing a global Tangram object. */
export function setWorkerURL(url: string): void {
    workerURL = url;
    registerTaskWorkerURL(url);
}

/** Returns the core bundle's default worker URL; explicit scene options take precedence. */
export function getWorkerURL(): string | undefined {
    return workerURL;
}
