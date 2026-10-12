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
triangle ID. Each balanced partition uses in-place median selection to split the
longest bounds axis without fully sorting each level or retaining a JavaScript order array. Build cost
and retained arrays grow with mesh size; heavily overlapping geometry can still
require linear query work. `triangleCount` and `arrayBytes` expose triangle count
and exact retained typed-array bytes. Nodes use packed Float64 bounds and Uint32
topology, not retained per-node JavaScript objects. `geometryBytes` counts the
immutable positions and original indices; `hierarchyBytes` counts acceleration
storage. `requiredHierarchyBytes` is available before allocation.

The optional fourth constructor argument is `{lazy, maxHierarchyBytes}`.
`lazy: true` defers acceleration until a ray intersects the whole-mesh bounds.
`maxHierarchyBytes` is a non-negative integer cap on retained hierarchy arrays;
when the complete hierarchy cannot fit, queries test triangles linearly with the
same clipping, acceptance and tie rules. Zero disables acceleration, not picking.
Construction scratch, JavaScript objects and caller buffers are not included.
`getTriangleVertex(triangleIndex, vertex)` returns a detached position and its
original vertex index without exposing mutable backing storage.
`getVertexIndex(triangleIndex, vertex)` reads just that identity without allocating
coordinate arrays; both accessors reject invalid triangle/vertex offsets.
`getBounds()` returns detached conservative XYZ bounds (including unreferenced
vertices), or `null` for empty geometry; it does not build acceleration.

## Cooperative warming

For a lazy index, consume `prepareHierarchySteps()` over host-driven slices before
querying. The generator yields between bounds scans, median-selection chunks and
nodes. Packed arrays allocate up front and count in `hierarchyBytes` while pending;
only a complete hierarchy becomes queryable. During preparation, queries use exact
linear intersection without restarting or traversing partial work. Calling
`iterator.return()` discards pending arrays, and a later iterator can retry.
Already completed, empty or over-budget indexes require no work. A concurrent
second iterator is a no-op; the host owns progression of the first one.

`TerrainMeshSurface.prepareQueryIndexSteps()` exposes the same warming boundary.
Geometry snapshot construction remains synchronous; warming targets are not hard
frame-time guarantees. Without explicit warming, the first bounds-intersecting
query still consumes the same builder synchronously.

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
Child bounds are traversed near-first. Farther queued nodes are skipped only when
their entry exceeds an accepted hit, preserving closed clipping and stable ties.

`TerrainMeshSurface` owns one copied geometry snapshot in this index and builds
only its hierarchy lazily. Its `maxQueryIndexBytes` option controls that hierarchy;
`getStatistics()` reports geometry, allocated hierarchy and required hierarchy
bytes. Physical heights have their own detached Float64 snapshot. A first pick
no longer duplicates the geometry arrays.
The [terrain example](../../developer-guide/terrain.md) retains a separate
common-space index per top mesh, projecting screen rays with the current deck
viewport. Visual skirts never enter these queries.
