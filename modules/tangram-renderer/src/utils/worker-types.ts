// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/** Worker transport surface; registration still requires a native Worker. */
export type BrokerWorker = Pick<Worker, 'postMessage' | 'addEventListener'>;

/** Remote method name and optional serialization for non-cloneable log arguments. */
export type BrokerMethod = string | {method: string; stringify?: boolean};

/** Invocation crossing the main/worker boundary. Arguments are not known to the transport. */
export interface BrokerInvocation {
    type: 'main_send' | 'worker_send';
    message_id: number;
    method: string;
    message: unknown[];
    /** Optional diagnostic target supplied by older callers. */
    target?: string;
}

/** Reply crossing the main/worker boundary. Truthy errors reject the pending invocation. */
export interface BrokerReply {
    type: 'main_reply' | 'worker_reply';
    message_id: number;
    message?: unknown;
    error?: unknown;
}

/** Wire packet, decoded once at the transport boundary. */
export type BrokerPacket = BrokerInvocation | BrokerReply;

/** Promise callbacks retained until a reply arrives. */
export interface PendingBrokerMessage {
    method: string;
    message: unknown[];
    resolve(value: unknown): void;
    reject(error: unknown): void;
}

/** Buffer and its original owner, used for legacy post-transfer cleanup. */
export interface BrokerTransferable {
    object: ArrayBuffer;
    parent: object | null;
    property: string | number | null;
}

/** Tuple of remote arguments or the single result wrapped for buffer transfer. */
export interface TransferEnvelope<Values extends unknown[] = unknown[]> {
    value: Values;
    transferables: BrokerTransferable[];
}

/** The legacy wrapper supports both ordinary calls and construction. */
export interface TransferEnvelopeFactory {
    <Values extends unknown[]>(...value: Values): TransferEnvelope<Values>;
    new <Values extends unknown[]>(...value: Values): TransferEnvelope<Values>;
}

/** Thread-specific invocation overloads; the caller supplies its remote result contract. */
export interface BrokerPostMessage {
    <Result = unknown>(workers: BrokerWorker[], method: BrokerMethod, ...message: unknown[]): Promise<Result[]>;
    <Result = unknown>(worker: BrokerWorker, method: BrokerMethod, ...message: unknown[]): Promise<Result>;
    <Result = unknown>(method: BrokerMethod, ...message: unknown[]): Promise<Result>;
}

/** Staged broker object shared with the logger during circular module initialization. */
export interface WorkerBrokerApi {
    targets: Record<string, unknown>;
    addTarget(name: string, target: unknown): void;
    removeTarget(name: string): void;
    postMessage: BrokerPostMessage;
    /** Installed on the main thread only. */
    addWorker(worker: Worker): void;
    /** Main-thread debugging access to pending invocations. */
    getMessages(): Record<number, PendingBrokerMessage>;
    /** Main-thread debugging access to the next invocation identifier. */
    getMessageId(): number;
    withTransferables: TransferEnvelopeFactory;
}
