{/*
tangram-layers
SPDX-License-Identifier: MIT
Copyright (c) vis.gl contributors
 */}

# Triangle queries

<span className="badge badge--warning">Status: Experimental</span>

`TriangleQueryIndex` is an immutable CPU bounds hierarchy for indexed XYZ triangles.
It uses math.gl's two-sided ray/bounds and ray/triangle kernels, without a scene,
projection, camera, GPU, worker or loading dependency.

```ts
import {TriangleQueryIndex} from '@vis.gl/tangram-renderer/map-logic';

const index = new TriangleQueryIndex(positions, indices); // XYZ, three indices per triangle
const result = index.queryRay([x, y, z], [0, 0, -1], maximumDistance);
// result.hit: {triangleIndex, parameter, barycentric} or null
// result.testedBounds, result.testedTriangles: deterministic work counts
```

## Geometry and ownership

Construction copies finite positions into Float64 and indices into Uint32 storage.
Caller mutation cannot alter the index. Invalid dimensions, indices or leaf sizes
throw. The optional third constructor argument sets leaf size from 1 to 64; the
default is 8. Empty and degenerate meshes produce no hit.

Triangle IDs and barycentric weights refer to the **original** index order, not
the hierarchy's partition order. Equal-distance ties select the lower original
triangle ID. Each balanced partition uses the existing lightweight `quickselect`
dependency to split the longest bounds axis without fully sorting each level. Build cost
and retained arrays grow with mesh size; heavily overlapping geometry can still
require linear query work. `triangleCount` and `arrayBytes` expose triangle count
and typed-array bytes; `arrayBytes` excludes hierarchy-object overhead.

## Rays and clipping

Rays use the mesh's coordinate system. Directions are not normalized:
`position = origin + direction × parameter`. A unit direction makes `parameter`
a distance in mesh units. The closed forward segment includes zero and
`maxParameter`, which defaults to infinity. Negative/NaN limits throw; nonfinite
or zero-length rays return no hit. Coplanar rays do not intersect triangles.

The optional fourth `queryRay` argument is an acceptance predicate over candidate
hits. Rejected hits do not clip away farther valid geometry; terrain uses this to
skip the geographically undefined globe center. Keep predicates deterministic
and avoid mutating the supplied hit.

`TerrainMeshSurface` builds this index lazily for physical Mercator/globe queries.
The [terrain example](../../developer-guide/terrain.md) retains a separate
common-space index per top mesh, projecting screen rays with the current deck
viewport. Visual skirts never enter these queries.
