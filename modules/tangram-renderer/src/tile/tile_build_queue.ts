// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/** A single source/style generation's tile build. */
export interface TileBuildTask {
    /** Source-normalized tile key. */
    readonly key: string;
    /** Tile identity and scene generation, used to reject stale completions. */
    readonly token: string;
    /** Visible detail precedes pinned preload, which precedes off-screen work. */
    priority: number;
    /** Start worker processing; completion is reported separately. */
    start(): void;
    /** Release ownership when starting the task fails synchronously. */
    fail(error: unknown): void;
}

/** Bounded, stable-priority scheduling shared by all eyes and data sources. */
export default class TileBuildQueue {
    /** Builds that have been submitted to workers. */
    private readonly active = new Map<string, TileBuildTask>();
    /** Latest unsent generation for each tile key, in stable insertion order. */
    private readonly pending = new Map<string, TileBuildTask>();
    /** Unlimited unless the host opts into a build limit. */
    private limit = Infinity;
    /** Prevent synchronous completion/failure callbacks from recursively pumping. */
    private pumping = false;
    /** Nested visibility updates must install all priorities before any submission. */
    private suspensionDepth = 0;

    /** Set a validated concurrency limit without cancelling active work. */
    setLimit(limit: number | undefined): void {
        this.limit = limit ?? Infinity;
    }

    /** Begin an atomic source/eye-union update without submitting stale queued work. */
    suspend(): void { this.suspensionDepth++; }

    /** Commit a batch and resume priority-based submission after the outermost update. */
    resume(): void {
        this.suspensionDepth = Math.max(0, this.suspensionDepth - 1);
        this.pump();
    }

    /** Queue the latest generation; a duplicate active task is not submitted twice. */
    enqueue(task: TileBuildTask): void {
        if (this.active.get(task.key)?.token === task.token) return;
        this.pending.set(task.key, task);
        this.pump();
    }

    /** Update unsent work when the shared eye-union visibility changes. */
    setPriority(key: string, priority: number): void {
        const task = this.pending.get(key);
        if (task) task.priority = priority;
    }

    /** Release only the matching generation; late worker replies cannot free new work. */
    finish(key: string, token: string): boolean {
        if (this.active.get(key)?.token !== token) return false;
        this.active.delete(key);
        this.pump();
        return true;
    }

    /** Remove a tile's queued and active ownership after the caller cancels its worker. */
    cancel(key: string): void {
        this.pending.delete(key);
        this.active.delete(key);
    }

    /** Whether any generation of a tile still owns queue state. */
    has(key: string): boolean {
        return this.active.has(key) || this.pending.has(key);
    }

    /** Active and unsent counts, detached from the queue's internal maps. */
    getCounts(): {activeBuilds: number; queuedBuilds: number} {
        return {activeBuilds: this.active.size, queuedBuilds: this.pending.size};
    }

    /** Submit available slots, retaining stable ordering among equal priorities. */
    pump(): void {
        if (this.pumping || this.suspensionDepth > 0) return;
        this.pumping = true;
        try {
            while (this.active.size < this.limit) {
                let next: TileBuildTask | undefined;
                for (const task of this.pending.values()) {
                    if (!this.active.has(task.key) && (!next || task.priority < next.priority)) next = task;
                }
                if (!next) break;
                this.pending.delete(next.key);
                this.active.set(next.key, next);
                try { next.start(); }
                catch (error) {
                    this.active.delete(next.key);
                    next.fail(error);
                }
            }
        } finally { this.pumping = false; }
    }

    /** Release all queue metadata during scene teardown. */
    clear(): void {
        this.pending.clear();
        this.active.clear();
    }
}
