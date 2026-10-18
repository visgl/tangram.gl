// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/** Independently reported storage domains; GPU bytes are estimates, not driver allocation measurements. */
export type TerrainResourceDomain = 'retained' | 'transient' | 'gpu';

/** An owned reservation. Releasing twice is safe, including cancellation racing completion. */
export interface TerrainResourceLease {
    /** Atomically change this reservation without temporarily releasing its old allocation. */
    resize(bytes: number): boolean;
    /** Release this owner's reservation. */
    release(): void;
}

/** Shared admission across source, preparation and renderer owners; never takes resource disposal ownership. */
export class TerrainResourceBudget {
    /** Validated total reservation limit, in bytes. */
    readonly byteLimit: number;
    /** Current allocations, keyed by opaque lease identity rather than reusable tile names. */
    private readonly allocations = new Map<object, {domain: TerrainResourceDomain; bytes: number}>();
    /** Largest simultaneously reserved total since construction. */
    private peakBytes = 0;
    /** Current total, updated without rescanning every owner. */
    private bytes = 0;

    /** Construct a finite hard admission limit; reservations must precede the represented allocation. */
    constructor(byteLimit: number) {
        validateBytes(byteLimit);
        this.byteLimit = byteLimit;
    }

    /** Reserve before allocating; rejection leaves every incumbent owner unchanged. */
    reserve(domain: TerrainResourceDomain, bytes: number): TerrainResourceLease | null {
        validateBytes(bytes);
        if (!['retained', 'transient', 'gpu'].includes(domain)) throw new Error('Invalid terrain resource domain');
        if (bytes > this.byteLimit - this.bytes) return null;
        const identity = {};
        this.allocations.set(identity, {domain, bytes});
        this.bytes += bytes; this.peakBytes = Math.max(this.peakBytes, this.bytes);
        return {
            resize: next => {
                validateBytes(next);
                const allocation = this.allocations.get(identity);
                if (!allocation || next - allocation.bytes > this.byteLimit - this.bytes) return false;
                this.bytes += next - allocation.bytes;
                allocation.bytes = next; this.peakBytes = Math.max(this.peakBytes, this.bytes);
                return true;
            },
            release: () => {
                const allocation = this.allocations.get(identity);
                if (allocation) {this.bytes -= allocation.bytes; this.allocations.delete(identity);}
            }
        };
    }

    /** Detached exact reservations; unregistered resources and driver overhead are deliberately not implied. */
    getStatistics(): {bytes: number; peakBytes: number; byteLimit: number; retainedBytes: number; transientBytes: number; gpuBytes: number; leases: number} {
        const totals = {retained: 0, transient: 0, gpu: 0};
        for (const allocation of this.allocations.values()) totals[allocation.domain] += allocation.bytes;
        return {bytes: this.bytes, peakBytes: this.peakBytes, byteLimit: this.byteLimit,
            retainedBytes: totals.retained, transientBytes: totals.transient, gpuBytes: totals.gpu, leases: this.allocations.size};
    }
}

/** Reject overflow and fractional reservations before changing an owner. */
function validateBytes(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('Invalid terrain resource byte reservation');
}
