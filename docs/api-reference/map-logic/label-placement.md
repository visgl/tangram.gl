{/*
tangram-layers
SPDX-License-Identifier: MIT
Copyright (c) vis.gl contributors
 */}

# Label placement

<span className="badge badge--warning">Status: Experimental</span>

`resolveLabelPlacement(candidates, options)` resolves collision, repeats and linked
placement across named views. It returns a read-only visibility map keyed by the
original candidate objects, without mutating inputs. Each invocation owns its
index and state.

```ts
import {resolveLabelPlacement} from '@vis.gl/tangram-renderer/map-logic';
import type {ScreenLabelCandidate, ScreenBounds} from '@vis.gl/tangram-renderer/map-logic';

const candidates: ScreenLabelCandidate[] = [
  {id: 'primary', boxes: new Map<string, ScreenBounds>([['map', [10, 10, 50, 30]]])},
  {id: 'secondary', boxes: new Map<string, ScreenBounds>([['map', [20, 10, 60, 30]]])}
];
const visibility = resolveLabelPlacement(candidates, {
  viewports: new Map([['map', {width: 800, height: 600}]])
});
// visibility.get(candidates[0]) === true
// visibility.get(candidates[1]) === false
```

## Inputs

Provide `ScreenLabelCandidate` objects in desired priority order, with unique
`id` values and finite, ordered, already padded/clipped local CSS-pixel rectangles.
Every view named in `boxes` needs dimensions in `options.viewports`.

| Field | Contract |
| --- | --- |
| `boxes` | Read-only map from view ID to `[minimumX, minimumY, maximumX, maximumY]`. Empty means hidden. |
| `collide` | `false` skips overlap rejection, not identity or repeat filtering. Defaults to enabled. |
| `repeatGroup`, `repeatDistance` | Minimum box-center spacing in CSS pixels for matching groups in shared views. Equality at the threshold is allowed; zero/omitted spacing disables this rule. |
| `linkedId` | Optional dependency. Reciprocal links form an atomic pair; a child may overlap its own parent. Missing links are ignored. |
| `identity` | Groups potential copies for the optional `options.isDuplicate(candidate, previous)` policy. Identity alone hides nothing. |

## Multi-view behavior

A candidate needs visible bounds in at least one view. Overlap in any shared view
rejects it, producing one mask for stereo or multi-view rendering. Bounds are local
to each viewport; do not include canvas/eye offsets.

The caller owns projection, eligibility, font measurement, priority sorting,
alternate-anchor selection, occlusion, geometry and rendering. Tangram's adapter
retains shader/packed-vertex reconstruction and GPU visibility uploads.

For geographic duplicate filtering, supply an equivalence policy using
[`areGeographicLabelCopies`](./label-identity.md).
