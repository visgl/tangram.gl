<!--
tangram-layers
SPDX-License-Identifier: MIT
Copyright (c) vis.gl contributors
-->

# Browser math assets

This private workspace builds math.gl entries for the standalone examples,
website examples and homepage hero. Run `yarn build:browser-dependencies` at
the repository root; `yarn build` and website preparation include this step.

The build uses the shared Ocular target policy and the installed, lockfile-pinned
packages. `dist/` is generated, ignored and copied into the website under
`examples/browser-dependencies/dist/`. Import maps use same-origin URLs rather
than a CDN's on-demand package builds. Relative standalone URLs and Docusaurus
base URLs support non-root deployments.

Only the exact `@math.gl/core` class entry remains external in dependent assets;
numeric subpaths are bundled. All consumers map that entry to the same `core.js`.
Installed third-party license notices accompany the emitted code. The Node tests
audit imports and mappings, and Chromium exercises the emitted bytes without
network dependencies or Vite rewriting their imports.

This does not replace other examples' deck.gl/luma.gl or optional gesture CDN
imports, change renderer exports, or force deck.gl 9.4 onto math.gl 5.
