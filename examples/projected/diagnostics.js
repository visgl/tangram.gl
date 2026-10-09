// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/** Accept loads for the current source scene, even if its projection/detail settings changed. */
export function createProjectedSceneLoadHandler(configuration, getCurrentConfiguration, onSceneLoad) {
  return scene => {
    if (getCurrentConfiguration() === configuration) onSceneLoad(scene);
  };
}

/** Format detached host/worker work counters separately from current renderer residency. */
export function formatProjectedDiagnostics(workers, resources, host) {
  const hostText = host ? ` Host kernel work: ${host.activeRequests} active, ${host.completedRequests} completed, ` +
    `${host.failedRequests} failed / ${host.cancelledRequests} cancelled requests; ${host.batches} calls / ` +
    `${host.submittedPositions} submitted positions; ${host.yieldCount} yields (${host.maxBatchPositions} positions/call limit).` : '';
  const totals = {completedMeshes: 0, failedMeshes: 0, sourceVertices: 0, outputVertices: 0,
    outputTriangles: 0, projectionBatches: 0, projectedPositions: 0, edgeRounds: 0, interiorRounds: 0};
  let supported = false;
  for (const worker of workers) if (worker.projectionWork) {
    supported = true;
    for (const key of Object.keys(totals)) totals[key] += worker.projectionWork[key];
  }
  if (!supported) return `Waiting for projected-worker diagnostics…${hostText}`;
  return `Cumulative work: ${totals.completedMeshes} meshes, ${totals.sourceVertices} → ${totals.outputVertices} vertices, ` +
    `${totals.outputTriangles} triangles; ${totals.edgeRounds} edge / ${totals.interiorRounds} interior rounds; ` +
    `${totals.projectionBatches} batches / ${totals.projectedPositions} positions; ${totals.failedMeshes} failures. ` +
    `Current residency: ${resources.activeBuilds} active / ${resources.queuedBuilds} queued builds, ` +
    `${resources.cachedTiles} evictable tiles (${(resources.cachedMeshBytes / 1000000).toFixed(1)} MB mesh buffers).${hostText}`;
}

/** Poll one scene at a time; stale or disposed replies never update the example. */
export function createProjectedDiagnosticsPoller(getScene, updateText) {
  let pending = false;
  let disposed = false;
  async function update() {
    const scene = getScene();
    if (disposed || pending || !scene) return;
    pending = true;
    try {
      const workers = await scene.getTileSourceStatistics();
      if (!disposed && getScene() === scene) {
        updateText(formatProjectedDiagnostics(workers, scene.tile_manager.getResourceStatistics(), scene.getProjectionEngineStatistics?.()));
      }
    } catch (error) {
      if (!disposed && getScene() === scene) updateText(`Diagnostics unavailable: ${error.message}`);
    } finally {pending = false;}
  }
  const timer = setInterval(update, 1000);
  return {update, destroy() {disposed = true; clearInterval(timer);}};
}
