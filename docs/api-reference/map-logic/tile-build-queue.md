{/*
tangram-layers
SPDX-License-Identifier: MIT
Copyright (c) vis.gl contributors
 */}

# Tile build queue

<span className="badge badge--warning">Status: Experimental</span>

`TileBuildQueue` schedules callback-based builds with stable priority ordering,
bounded concurrency, latest queued generations and stale-completion protection.
It owns metadata only; the caller owns cancellation, workers and resources.

```ts
import {TileBuildQueue} from '@vis.gl/tangram-renderer/map-logic';

const queue = new TileBuildQueue();
queue.setLimit(2);
queue.enqueue({
  key: 'source/0/0/0',
  token: 'scene-generation-1',
  priority: 0,
  start() {
    // Submit worker work, then call queue.finish(key, token) on completion.
  },
  fail(error) {
    // Release caller-owned state if start() throws synchronously.
    console.error(error);
  }
});
```

## Tasks and ordering

`TileBuildTask` supplies `key`, generation `token`, numeric `priority`, `start()`
and `fail(error)`. Lower priorities start first; equal priorities preserve queue
insertion order. Re-enqueuing the same active key/token does nothing. A newer
pending generation replaces the unsent one for that key.

## Methods

| Method | Behavior |
| --- | --- |
| `setLimit(limit)` | Set an already validated positive concurrency limit, or `undefined` for unlimited. Does not cancel active work or start queued work itself. |
| `enqueue(task)` | Queue a generation and submit available work. |
| `setPriority(key, priority)` | Update pending work only; call `pump()` or finish a batch to apply it. |
| `suspend()`, `resume()` | Batch changes with nesting; the outermost resume pumps the queue. |
| `finish(key, token)` | Release only the matching active generation and pump; return whether it matched. Report both successful and failed asynchronous completions. |
| `cancel(key)` | Remove active/pending metadata after the caller cancels work; call `pump()` to fill freed slots. |
| `has(key)` | Check active or pending ownership. |
| `getCounts()` | Return detached `activeBuilds` and `queuedBuilds` counts. |
| `pump()` | Submit available slots, guarded against recursive synchronous callbacks. |
| `clear()` | Remove all metadata; it does not cancel work or reset the limit/suspension depth. |

A thrown `start()` invokes `fail(error)` and frees that slot. Asynchronous errors
are the caller's responsibility. Keep failure callbacks non-throwing and do not
reuse canceled generation tokens for new work.
