// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {useEffect, useRef, useState} from 'react';

/** Mount the offline terrain contract example in the website. */
export default function TerrainContractExample() {
  const host = useRef(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    let cancelled = false;
    let dispose;
    import('../../../examples/layers/terrain-contract/app').then(module => {
      if (!cancelled && host.current) dispose = module.mountTerrainContractExample(host.current);
    }).catch(exception => { if (!cancelled) setError(exception.message); });
    return () => { cancelled = true; dispose?.(); };
  }, []);
  return <div style={{position: 'relative', height: '100%', minHeight: 480}}>
    <div ref={host} style={{position: 'absolute', inset: 0}} />
    {error ? <p role="alert">Unable to load example: {error}</p> : null}
  </div>;
}
