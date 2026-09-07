---
sidebar_position: 4
title: Leaflet integration
description: Run the packaged Tangram renderer as a Leaflet layer.
hide_title: true
---

{/*
tangram-layers
SPDX-License-Identifier: MIT
Copyright (c) vis.gl contributors
 */}

import ClassicPlayground from '@site/src/components/ClassicPlayground';

# Leaflet integration

The classic example is packaged under [`examples/classic`](https://github.com/visgl/tangram.gl/tree/master/examples/classic) and runs Tangram as a Leaflet layer. It keeps the historical Leaflet interaction model—pan, zoom, feature selection, and scene editing—while loading the renderer from the workspace package.

<ClassicPlayground />
