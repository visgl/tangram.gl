{/*
tangram-layers
SPDX-License-Identifier: MIT
Copyright (c) vis.gl contributors
 */}

# Screen bounds

<span className="badge badge--warning">Status: Experimental</span>

`ScreenBounds` is a read-only tuple
`[minimumX, minimumY, maximumX, maximumY]` in local CSS pixels.
`LabelViewport` supplies `width` and `height` in the same units.
Inputs must be finite, ordered rectangles; viewport dimensions must be positive.

```ts
import {intersectsScreenBounds, unionScreenBounds} from '@vis.gl/tangram-renderer/map-logic';

intersectsScreenBounds([0, 0, 20, 20], [20, 0, 40, 20]); // false: edge contact
unionScreenBounds([0, 0, 20, 20], [-5, 10, 30, 40]); // [-5, 0, 30, 40]
```

## Functions

- `intersectsScreenBounds(left, right)` tests strict axis-aligned overlap.
  Touching edges are allowed.
- `unionScreenBounds(left, right)` returns the enclosing rectangle without
  modifying inputs. If `left` is `undefined`, it returns `right` unchanged.
- `getScreenBoundsCells(bounds, viewport)` yields `column,row` keys for a
  64-CSS-pixel spatial index, limiting indices to the visible viewport. The
  maximum boundary cell is included conservatively; exact rectangle tests decide
  whether nearby candidates overlap.

These helpers do not project geometry, pad glyphs or account for canvas/eye
offsets. Those transformations belong to the caller.
