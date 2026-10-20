// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/** Independently reported storage domains; GPU bytes are estimates, not driver allocation measurements. */
export type TerrainResourceDomain = 'retained' | 'transient' | 'gpu';

/** One entry in an atomically admitted allocation batch. */
export interface TerrainResourceRequest {
    /** Independently reported storage category. */
    readonly domain: TerrainResourceDomain;
    /** Exact represented allocation bytes, a non-negative safe integer. */
    readonly bytes: number;
    /** Optional immutable allocation identity; matching owners count once. */
    readonly identity?: object;
}

/** An owned reservation. Releasing twice is safe, including cancellation racing completion. */
export interface TerrainResourceLease {
    /** Atomically resize a private reservation; shared immutable reservations permit only the same size. */
    resize(bytes: number): boolean;
    /** Release this owner's reservation. */
    release(): void;
}

/** Shared admission across source, preparation and renderer owners; never takes resource disposal ownership. */
export class TerrainResourceBudget {
    /** Validated total reservation limit, in bytes. */
    readonly byteLimit: number;
    /** Current allocations, keyed by opaque lease identity rather than reusable tile names. */
    private readonly allocations = new Map<object, {domain: TerrainResourceDomain; bytes: number; references: number}>();
    /** Weak allocation identities permit independent owners to retain one immutable allocation once. */
    private readonly sharedIdentities = new WeakMap<object, object>();
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
        return this.reserveAll([{domain, bytes}])?.[0] ?? null;
    }

    /** Retain an immutable allocation by identity; shared leases permit only no-op resizing. */
    reserveShared(identity: object, domain: TerrainResourceDomain, bytes: number): TerrainResourceLease | null {
        return this.reserveAll([{identity, domain, bytes}])?.[0] ?? null;
    }

    /** Create a lease only after its complete admission has been validated. */
    private createLease(domain: TerrainResourceDomain, bytes: number, shared?: object): TerrainResourceLease {
        const identity = (shared ? this.sharedIdentities.get(shared) : undefined) ?? {};
        let allocation = this.allocations.get(identity);
        if (allocation) allocation.references++;
        else {
            allocation = {domain, bytes, references: 1};
            this.allocations.set(identity, allocation);
            if (shared) this.sharedIdentities.set(shared, identity);
            this.bytes += bytes; this.peakBytes = Math.max(this.peakBytes, this.bytes);
        }
        const allocationIdentity = identity;
        const owned = allocation;
        let active = true;
        return {
            resize: next => {
                validateBytes(next);
                if (!active || shared && next !== owned.bytes || next - owned.bytes > this.byteLimit - this.bytes) return false;
                this.bytes += next - owned.bytes;
                owned.bytes = next; this.peakBytes = Math.max(this.peakBytes, this.bytes);
                return true;
            },
            release: () => {
                if (!active) return;
                active = false; owned.references--;
                if (!owned.references) {this.bytes -= owned.bytes; this.allocations.delete(allocationIdentity);}
            }
        };
    }

    /** Admit a complete set atomically; invalid or over-budget batches allocate no leases. */
    reserveAll(requests: readonly TerrainResourceRequest[]): TerrainResourceLease[] | null {
        const entries = requests.map(({domain, bytes, identity}) => ({domain, bytes, identity}));
        let total = 0;
        const planned = new Map<object, {domain: TerrainResourceDomain; bytes: number}>();
        for (const request of entries) {
            validateBytes(request.bytes);
            if (!['retained', 'transient', 'gpu'].includes(request.domain)) throw new Error('Invalid terrain resource domain');
            if (request.identity !== undefined) {
                if (request.identity === null || typeof request.identity !== 'object') throw new Error('Invalid shared terrain resource identity');
                const identity = this.sharedIdentities.get(request.identity);
                const allocation = identity ? this.allocations.get(identity) : undefined;
                const previous = allocation ?? planned.get(request.identity);
                if (previous) {
                    if (previous.domain !== request.domain || previous.bytes !== request.bytes) throw new Error('Shared terrain resource metadata must match');
                    continue;
                }
                planned.set(request.identity, request);
            }
            if (request.bytes > Number.MAX_SAFE_INTEGER - total) throw new Error('Invalid terrain resource byte reservation');
            total += request.bytes;
        }
        if (total > this.byteLimit - this.bytes) return null;
        return entries.map(request => this.createLease(request.domain, request.bytes, request.identity));
    }

    /** Detached unique allocation bytes and live owner-lease count; excludes unregistered resources and driver overhead. */
    getStatistics(): {bytes: number; peakBytes: number; byteLimit: number; retainedBytes: number; transientBytes: number; gpuBytes: number; leases: number} {
        const totals = {retained: 0, transient: 0, gpu: 0};
        let leases = 0;
        for (const allocation of this.allocations.values()) {totals[allocation.domain] += allocation.bytes; leases += allocation.references;}
        return {bytes: this.bytes, peakBytes: this.peakBytes, byteLimit: this.byteLimit,
            retainedBytes: totals.retained, transientBytes: totals.transient, gpuBytes: totals.gpu, leases};
    }
}

/** Reject overflow and fractional reservations before changing an owner. */
function validateBytes(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('Invalid terrain resource byte reservation');
}
