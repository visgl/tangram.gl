// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {afterEach, describe, expect, expectTypeOf, test, vi} from 'vitest';
// Enter through the existing logger-first cycle, as renderer/worker entrypoints do.
import '../src/utils/log';
import Utils from '../src/utils/utils';
import WorkerBroker from '../src/utils/worker_broker';
import FeatureSelection from '../src/selection/selection';
import type {BrokerInvocation, BrokerPacket, BrokerReply, TransferEnvelope} from '../src/utils/worker-types';
import type {SelectionReply, SelectionResult, SelectionTile} from '../src/selection/selection-types';

const workers: Worker[] = [];
const urls: string[] = [];
const targetName = 'typedSelectionContract';

afterEach(() => {
    for (const worker of workers.splice(0)) worker.terminate();
    for (const url of urls.splice(0)) URL.revokeObjectURL(url);
    WorkerBroker.removeTarget(targetName);
    FeatureSelection.reset();
    FeatureSelection.setPrefix(0);
    vi.restoreAllMocks();
});

/** Native Worker fixture whose main-thread transport is controllable without public network access. */
function createControlledWorker() {
    const url = URL.createObjectURL(new Blob(['self.onmessage = () => {};'], {type: 'text/javascript'}));
    urls.push(url);
    const worker = new Worker(url);
    workers.push(worker);
    const post = vi.spyOn(worker, 'postMessage').mockImplementation(() => {});
    WorkerBroker.addWorker(worker);
    return {worker, post};
}

/** Deliver a typed wire packet through the actual broker listener. */
function deliverPacket(worker: Worker, packet: BrokerPacket | string): void {
    worker.dispatchEvent(new MessageEvent('message', {data: packet}));
}

/** Decode the last captured packet at the test transport boundary. */
function readPacket(post: ReturnType<typeof createControlledWorker>['post']): BrokerPacket {
    const value: unknown = post.mock.calls.at(-1)![0];
    return (typeof value === 'string' ? JSON.parse(value) : value) as BrokerPacket;
}

describe('checked worker protocol', () => {
    test('resolves serialized replies by ID, rejects truthy errors, and removes pending callbacks', async () => {
        const {worker, post} = createControlledWorker();
        const first = WorkerBroker.postMessage<number>(worker, {method: 'self.square', stringify: true}, 5);
        expectTypeOf(first).toEqualTypeOf<Promise<number>>();
        expect(post.mock.calls[0][0]).toEqual(expect.any(String));
        const invocation = readPacket(post) as BrokerInvocation;
        expect(invocation).toMatchObject({type: 'main_send', method: 'self.square', message: [5]});
        expect(WorkerBroker.getMessages()[invocation.message_id].message).toEqual([5]);
        deliverPacket(worker, JSON.stringify({type: 'worker_reply', message_id: invocation.message_id, message: 25}));
        expect(await first).toBe(25);
        expect(WorkerBroker.getMessages()[invocation.message_id]).toBeUndefined();
        deliverPacket(worker, {type: 'worker_reply', message_id: invocation.message_id, message: 'duplicate'});

        const failed = WorkerBroker.postMessage(worker, 'self.fail');
        const rejected = expect(failed).rejects.toBe('remote failure');
        const identifier = readPacket(post).message_id;
        deliverPacket(worker, {type: 'worker_reply', message_id: identifier, error: 'remote failure'});
        await rejected;
        expect(WorkerBroker.getMessages()[identifier]).toBeUndefined();

        const successful = WorkerBroker.postMessage<boolean>(worker, 'self.falsyError');
        deliverPacket(worker, {type: 'worker_reply', message_id: readPacket(post).message_id, error: '', message: false});
        expect(await successful).toBe(false);
    });

    test('fans out to workers while retaining input order and distinct identifiers', async () => {
        const first = createControlledWorker(), second = createControlledWorker();
        const result = WorkerBroker.postMessage<number>([first.worker, second.worker], 'self.value', 4);
        expectTypeOf(result).toEqualTypeOf<Promise<number[]>>();
        const firstIdentifier = readPacket(first.post).message_id;
        const secondIdentifier = readPacket(second.post).message_id;
        expect(secondIdentifier).toBe(firstIdentifier + 1);
        deliverPacket(second.worker, {type: 'worker_reply', message_id: secondIdentifier, message: 8});
        deliverPacket(first.worker, {type: 'worker_reply', message_id: firstIdentifier, message: 4});
        expect(await result).toEqual([4, 8]);
    });

    test('dispatches nested main targets with their receiver, synchronous/async results and forwarded errors', async () => {
        const {worker, post} = createControlledWorker();
        WorkerBroker.addTarget(targetName, {nested: {
            base: 3,
            sum(this: {base: number}, value: number) { return this.base + value; },
            async asyncValue() { return 9; },
            fail() { throw new Error('sync failure'); },
            async reject() { throw new Error('async failure'); },
            async rejectValue() { throw 'string failure'; },
            value: 7
        }});
        deliverPacket(worker, {type: 'worker_send', message_id: 100, method: `${targetName}.nested.sum`, message: [2]});
        expect(readPacket(post)).toMatchObject({type: 'main_reply', message_id: 100, message: 5});
        deliverPacket(worker, {type: 'worker_send', message_id: 101, method: `${targetName}.nested.asyncValue`, message: []});
        await Promise.resolve();
        expect(readPacket(post)).toMatchObject({message_id: 101, message: 9});
        for (const method of ['fail', 'reject', 'rejectValue', 'value', 'missing.deep']) {
            deliverPacket(worker, {type: 'worker_send', message_id: 102, method: `${targetName}.nested.${method}`, message: []});
            await Promise.resolve();
            const reply = readPacket(post) as BrokerReply;
            expect(reply.error).toEqual(expect.any(String));
            expect(reply).toMatchObject({type: 'main_reply', message_id: 102});
        }
        WorkerBroker.removeTarget(targetName);
        deliverPacket(worker, {type: 'worker_send', message_id: 103, method: `${targetName}.nested.sum`, message: []});
        expect((readPacket(post) as BrokerReply).error).toContain('no object');
    });

    test('keeps callable/constructable tuple envelopes and legacy transferable cleanup semantics', async () => {
        const {worker, post} = createControlledWorker();
        const first = new ArrayBuffer(2), second = new Uint8Array([1, 2]), third = new ArrayBuffer(3);
        const properties = {first, nested: {second}, third: [null, third], empty: null};
        const envelope = WorkerBroker.withTransferables(properties, 'argument');
        expectTypeOf(envelope).toEqualTypeOf<TransferEnvelope<[typeof properties, string]>>();
        expect(envelope).toBeInstanceOf(WorkerBroker.withTransferables);
        expect(new WorkerBroker.withTransferables(0).value).toEqual([0]);
        expect(envelope.transferables.map(item => item.object)).toEqual([first, second.buffer, third]);
        const pending = WorkerBroker.postMessage(worker, 'self.transfer', envelope);
        expect(post.mock.calls.at(-1)![1]).toEqual([first, second.buffer, third]);
        expect(properties).not.toHaveProperty('first');
        expect(properties.nested).not.toHaveProperty('second');
        expect(1 in properties.third).toBe(false);
        expect(properties.empty).toBeNull();
        deliverPacket(worker, {type: 'worker_reply', message_id: readPacket(post).message_id});
        await pending;

        const buffer = new ArrayBuffer(4), values = [buffer];
        const direct = WorkerBroker.withTransferables(values);
        const directPending = WorkerBroker.postMessage(worker, 'self.transfer', direct);
        // Numeric property zero is intentionally retained by the existing truthy cleanup filter.
        expect(values[0]).toBe(buffer);
        deliverPacket(worker, {type: 'worker_reply', message_id: readPacket(post).message_id});
        await directPending;
    });

    test.each([false, true])('unwraps only the first returned tuple value, async=%s', async asynchronous => {
        const {worker, post} = createControlledWorker();
        const value = {bytes: new Uint8Array([3, 4])};
        const buffer = value.bytes.buffer;
        WorkerBroker.addTarget(targetName, {result: () => {
            const envelope = WorkerBroker.withTransferables(value, 'not a second result');
            return asynchronous ? Promise.resolve(envelope) : envelope;
        }});
        deliverPacket(worker, {type: 'worker_send', message_id: 200, method: `${targetName}.result`, message: []});
        await Promise.resolve();
        expect((readPacket(post) as BrokerReply).message).toBe(value);
        expect(post.mock.calls.at(-1)![1]).toEqual([buffer]);
        expect(value).not.toHaveProperty('bytes');
    });

    test('registration rejects a non-native endpoint', () => {
        expect(() => WorkerBroker.addWorker({} as Worker)).toThrow('non-Worker');
    });
});

test('native scene worker round-trips transferred arguments and build-owned selection metadata', async () => {
    const worker = new Worker(new URL('../build/worker.test.js', import.meta.url).href);
    workers.push(worker);
    WorkerBroker.addWorker(worker);
    const tile: SelectionTile = {key: 'typed-worker/0/0/0', coords: {x: 0, y: 0, z: 0},
        source: 'world', style_z: 0, generation: 1};
    await WorkerBroker.postMessage(worker, 'self.FeatureSelection.setPrefix', 2);
    const buffer = new Uint8Array([4, 5]).buffer;
    const properties = {name: 'road', buffer};
    const feature = {id: 7, properties};
    const color = await WorkerBroker.postMessage<SelectionEntryColor>(worker, 'self.FeatureSelection.makeColor',
        WorkerBroker.withTransferables(feature, tile, {source: 'world', layer: 'roads', layers: ['roads']}));
    expect(buffer.byteLength).toBe(0);
    // Any object with an ArrayBuffer-valued .buffer is treated as a typed-array owner.
    expect(feature).not.toHaveProperty('properties');
    expect(properties.buffer).toBe(buffer);
    expect(color).toEqual([1 / 255, 0, 0, 2 / 255]);
    const reply = await WorkerBroker.postMessage<SelectionReply>(worker, 'self.getFeatureSelection', {id: 9, key: (2 << 24) + 1});
    expect(reply).toMatchObject({id: 9, feature: {id: 7, source_name: 'world', source_layer: 'roads', tile}});
    const selected = reply.feature as {properties: {buffer: ArrayBuffer}};
    expect(Array.from(new Uint8Array(selected.properties.buffer))).toEqual([4, 5]);
    expectTypeOf(reply.feature).toEqualTypeOf<unknown>();
    await WorkerBroker.postMessage(worker, 'self.FeatureSelection.clearTile', tile.key);
    expect(await WorkerBroker.postMessage(worker, 'self.FeatureSelection.getMapSize')).toBe(0);
});

/** Normalized selection-color result expected from the worker's built-in map. */
type SelectionEntryColor = [number, number, number, number];

test('ordinary IO returns a response; main-thread proxy IO returns a transferable response envelope', async () => {
    const url = new URL('./fixtures/shared-tile-source.json', import.meta.url).href;
    const response = await Utils.io(url);
    expectTypeOf(response).toEqualTypeOf<{body: string | ArrayBuffer | null; status: number}>();
    expect(response.status).toBe(200);
    expect(typeof response.body).toBe('string');
    const proxied = await Utils.io(url, 60000, 'arraybuffer', 'GET', {}, 'typed-proxy', true);
    expect(proxied).toBeInstanceOf(WorkerBroker.withTransferables);
    if (!(proxied instanceof WorkerBroker.withTransferables)) throw new Error('Expected a transferable response');
    expect(proxied.value[0].status).toBe(200);
    expect(proxied.value[0].body).toBeInstanceOf(ArrayBuffer);
    expect(proxied.transferables.map(item => item.object)).toEqual([proxied.value[0].body]);
    expect(Utils._requests).not.toHaveProperty('typed-proxy');
});

test('selection replies preserve arbitrary payloads, stable change detection and sent/unsent cancellation', async () => {
    const framebuffer = {destroy: vi.fn()};
    const device = {createFramebuffer: () => framebuffer, createTexture: () => ({destroy: vi.fn()})};
    const selection = new FeatureSelection(null, [], undefined, device as unknown as import('@luma.gl/core').Device);
    const feature = {custom: ['street', 5]};
    const first = selection.getFeatureAt({x: 0.5, y: 0.5}, {radius: null});
    expectTypeOf(first).toEqualTypeOf<Promise<SelectionResult>>();
    selection.finishRead({id: 0, feature});
    expect(await first).toMatchObject({feature, changed: true});
    const repeated = selection.getFeatureAt({x: 0.5, y: 0.5}, {});
    selection.finishRead({id: 1, feature: {custom: ['street', 5]}});
    expect(await repeated).toMatchObject({changed: false});
    const sent = selection.getFeatureAt({x: 0.5, y: 0.5}, {});
    selection.requests[2].sent = true;
    const unsent = selection.getFeatureAt({x: 0.25, y: 0.25}, {});
    const rejected = expect(unsent).rejects.toMatchObject({request: {id: 3}});
    selection.clearPendingRequests();
    await rejected;
    expect(selection.requests[2].sent).toBe(true);
    selection.finishRead({id: 2});
    expect(await sent).toMatchObject({changed: true, feature: undefined});
    selection.destroy();
    expect(framebuffer.destroy).toHaveBeenCalledTimes(1);
});
