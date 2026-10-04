// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test, vi} from 'vitest';
import {notifyGPUResourceDisposal, observeGPUResourceDisposal} from '../src/gpu/resource_lifecycle';

test('disposal subscriptions are independent, cancellable and one-shot', () => {
    const owner = {};
    const otherOwner = {};
    const first = vi.fn();
    const second = vi.fn();
    const other = vi.fn();
    const cancel = observeGPUResourceDisposal(owner, first);
    observeGPUResourceDisposal(owner, second);
    observeGPUResourceDisposal(otherOwner, other);
    cancel();
    cancel();
    notifyGPUResourceDisposal(owner);
    notifyGPUResourceDisposal(owner);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    expect(other).not.toHaveBeenCalled();
    notifyGPUResourceDisposal(otherOwner);
    expect(other).toHaveBeenCalledTimes(1);
});

test('reentrant notification cannot repeat a generation, and new subscriptions survive', () => {
    const owner = {};
    const next = vi.fn();
    const first = vi.fn(() => {
        notifyGPUResourceDisposal(owner);
        observeGPUResourceDisposal(owner, next);
    });
    observeGPUResourceDisposal(owner, first);
    notifyGPUResourceDisposal(owner);
    expect(first).toHaveBeenCalledTimes(1);
    expect(next).not.toHaveBeenCalled();
    notifyGPUResourceDisposal(owner);
    expect(next).toHaveBeenCalledTimes(1);
});

test('one failing observer does not prevent remaining observers from releasing their caches', () => {
    const owner = {};
    const failure = new Error('cleanup failed');
    const remaining = vi.fn();
    observeGPUResourceDisposal(owner, () => { throw failure; });
    observeGPUResourceDisposal(owner, remaining);
    let caught: unknown;
    try { notifyGPUResourceDisposal(owner); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors).toEqual([failure]);
    expect(remaining).toHaveBeenCalledTimes(1);
    expect(() => notifyGPUResourceDisposal(owner)).not.toThrow();
});
