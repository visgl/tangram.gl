{/*
tangram-layers
SPDX-License-Identifier: MIT
Copyright (c) vis.gl contributors
 */}

# Label identity

<span className="badge badge--warning">Status: Experimental</span>

`areGeographicLabelCopies(candidate, previous, options)` identifies buffered
copies of the same label without importing a tile, camera or projection system.

```ts
import {areGeographicLabelCopies} from '@vis.gl/tangram-renderer/map-logic';

const original = {
  identity: 'city:123', sourceTileIdentity: 'tile-a', sourceZoom: 0,
  anchor: [0, 0] as const, height: 0
};
const bufferedCopy = {...original, sourceTileIdentity: 'tile-b'};
areGeographicLabelCopies(original, bufferedCopy, {
  worldWidth: 4096,
  wrapHorizontal: false
}); // true
```

## Coordinate contract

`GeographicLabelAnchor` supplies a nonempty matching `identity`, distinct
`sourceTileIdentity`, absolute projected XY `anchor`, equal quantized `height`
and `sourceZoom`. The helper does not quantize heights or compute identities.

`GeographicLabelIdentityOptions.worldWidth` uses the same units as the anchors.
The proximity tolerance is two 4096-unit tile steps at the lower source zoom:
`2 * worldWidth / (4096 * 2 ** minimumSourceZoom)`. The distance comparison includes
the tolerance boundary.

Set `wrapHorizontal: true` for one periodic surface such as Globe, where anchors
separated by a world width may describe the same location. Use `false` to preserve
distinct repeated Mercator worlds. Supply a finite positive world width and
finite coordinates/zoom values.

Use this helper as an injected duplicate policy for [label placement](./label-placement.md).
It does not hide labels or alter their anchors itself.
