// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/** Private, copied selection metadata for one logical view or resource consumer. */
interface TileConsumerState {
    /** Requested keys, including not-yet-loaded content. */
    selected: Set<string>;
    /** Drawable fallback and refinement keys. */
    visible: Set<string>;
}

/** Shared-consumer residency metadata; does not own tiles, loading or disposal. */
export class TileResidency<ConsumerId = symbol> {
    /** Consumers retain independent snapshots of their selected and visible keys. */
    private readonly consumers = new Map<ConsumerId, TileConsumerState>();

    /** Attach a consumer with empty state, resetting it if already attached. */
    attachConsumer(id: ConsumerId): void {
        this.updateConsumer(id, [], []);
    }

    /** Replace a consumer's state with copied keys; unknown consumers are attached. */
    updateConsumer(id: ConsumerId, selected: readonly string[], visible: readonly string[]): void {
        this.consumers.set(id, {selected: new Set(selected), visible: new Set(visible)});
    }

    /** Release only this consumer's protection, leaving other consumers intact. */
    detachConsumer(id: ConsumerId): void {
        this.consumers.delete(id);
    }

    /** Return a detached, deduplicated union in consumer and key insertion order. */
    getSelectedTileKeys(): string[] {
        return [...new Set([...this.consumers.values()].flatMap(consumer => [...consumer.selected]))];
    }

    /** Whether any consumer selects or displays a key, even if its content is not loaded. */
    isProtected(key: string): boolean {
        for (const consumer of this.consumers.values()) {
            if (consumer.selected.has(key) || consumer.visible.has(key)) return true;
        }
        return false;
    }

    /** Release all consumer metadata; no tile resources are unloaded. */
    clear(): void {
        this.consumers.clear();
    }
}
