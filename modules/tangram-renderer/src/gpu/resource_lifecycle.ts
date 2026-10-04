// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/** One-shot observers; weak keys do not keep retired scene owners alive. */
const observers = new WeakMap<object, Set<() => void>>();

/** Register cache cleanup for a mesh retirement or shader-resource replacement. */
export function observeGPUResourceDisposal(owner: object, dispose: () => void): () => void {
    let callbacks = observers.get(owner);
    if (!callbacks) {
        callbacks = new Set();
        observers.set(owner, callbacks);
    }
    callbacks.add(dispose);
    const registered = callbacks;
    return () => { registered.delete(dispose); };
}

/** Drain a generation's observers, even if one fails or registers a new generation. */
export function notifyGPUResourceDisposal(owner: object): void {
    const callbacks = observers.get(owner);
    if (!callbacks) return;
    observers.delete(owner);
    const pending = [...callbacks];
    callbacks.clear();
    const errors: unknown[] = [];
    for (const dispose of pending) {
        try { dispose(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'GPU cache disposal failed');
}
