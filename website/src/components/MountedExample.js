// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {useEffect, useRef, useState} from 'react';
import {useHistory} from '@docusaurus/router';
import useBaseUrl from '@docusaurus/useBaseUrl';
import '../../../examples/mounted-example.css';

/** Load a browser runtime only on its route, then mount it inside Docusaurus. */
export default function MountedExample({kind}) {
  const host = useRef(null);
  const history = useHistory();
  const workerPath = useBaseUrl('/modules/tangram-renderer/dist/projected-basemaps-worker.js');
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    let instance;
    setError(null);
    setLoading(true);
    const options = {
      parameters: new URLSearchParams(history.location.search),
      workerUrl: new URL(workerPath, window.location.origin).href,
      onParametersChange(parameters) {
        if (!cancelled) history.replace({...history.location, search: `?${parameters}`});
      }
    };
    const runtime =
      kind === 'terrain'
        ? import(/* webpackChunkName: "terrain-example" */ '@vis.gl/tangram-terrain-example/app')
        : import(
            /* webpackChunkName: "projected-example" */ '@vis.gl/tangram-projected-example/app'
          );
    runtime
      .then((module) => {
        if (cancelled) return;
        instance =
          kind === 'terrain'
            ? module.mountTerrainExample(host.current, options)
            : module.mountProjectedExample(host.current, options);
        setLoading(false);
      })
      .catch((exception) => {
        if (!cancelled) {
          setError(exception.message);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
      instance?.destroy();
    };
  }, [kind, history, workerPath]);

  return (
    <div className="native-example-embed">
      <div ref={host} className="native-example-host" />
      {loading ? (
        <p className="native-example-message" role="status">
          Loading example…
        </p>
      ) : null}
      {error ? (
        <p className="native-example-message alert alert--danger" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
