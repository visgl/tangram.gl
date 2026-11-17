// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {useEffect, useRef, useState} from 'react';

const EXAMPLES = {
  map: () => import('../../../examples/layers/basemap-layer-map-view/app')
    .then(module => module.mountBasemapLayerMapViewExample),
  split: () => import('../../../examples/basemap-layers/split-view/app')
    .then(module => module.mountBasemapSplitViewExample),
  'custom-projection': () => import('../../../examples/layers/basemap-layer-custom-projection/app')
    .then(module => module.mountBasemapCustomProjectionExample),
  'hover-and-select': () => import('../../../examples/layers/basemap-hover-and-select/app')
    .then(module => module.mountBasemapHoverAndSelectExample)
};

/** Mount the copied basemap examples directly in the documentation page. */
export default function BasemapLiveExample({split = false, example = split ? 'split' : 'map'}) {
  const host = useRef(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    let cancelled = false;
    let dispose;
    setError(null);
    EXAMPLES[example]().then((mount) => {
      if (!cancelled && host.current) {
        dispose = mount(host.current);
      }
    }).catch((exception) => {
      if (!cancelled) setError(exception.message);
    });
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [example]);
  return (
    <div style={{position: 'relative', height: '100%', minHeight: 480}}>
      <div ref={host} style={{position: 'absolute', inset: 0}} />
      {error ? <p role="alert">Unable to load example: {error}</p> : null}
    </div>
  );
}
