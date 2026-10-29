// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {useEffect, useRef, useState} from 'react';

/** Mount the copied basemap examples directly in the documentation page. */
export default function BasemapLiveExample({split = false}) {
  const host = useRef(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    let cancelled = false;
    let dispose;
    setError(null);
    const example = split
      ? import('../../../examples/basemap-layers/split-view/app')
      : import('../../../examples/layers/basemap-layer-map-view/app');
    example.then((module) => {
      if (!cancelled && host.current) {
        dispose = split
          ? module.mountBasemapSplitViewExample(host.current)
          : module.mountBasemapLayerMapViewExample(host.current);
      }
    }).catch((exception) => {
      if (!cancelled) setError(exception.message);
    });
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [split]);
  return (
    <div style={{position: 'relative', height: '100%', minHeight: 480}}>
      <div ref={host} style={{position: 'absolute', inset: 0}} />
      {error ? <p role="alert">Unable to load example: {error}</p> : null}
    </div>
  );
}
