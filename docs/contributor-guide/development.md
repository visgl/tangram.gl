{/*
tangram-layers
SPDX-License-Identifier: MIT
Copyright (c) vis.gl contributors
 */}

# Development workflow

## Setup and commands

Use the Node version in `.nvmrc` and Yarn version in `package.json`. Install
once at the repository root:

```sh
corepack enable
yarn install --immutable
yarn playwright:install  # Chromium for browser/GPU tests
```

The shared Ocular toolchain provides orchestration, Vitest and Biome:

```sh
yarn build          # clean, build modules, then classic playground
yarn build:modules  # renderer, layer and artifact-contract checks
yarn typecheck      # strict TypeScript, no emitted files
yarn lint           # licenses, Biome and TypeScript/suppression scope
yarn lint:fix       # license fixes and safe Biome fixes
yarn test-node
yarn test-headless  # build modules/workers and run Chromium unit tests
yarn test-rendering # build modules and run WebGL 2 regressions
TANGRAM_TEST_DEVICE=webgpu yarn test-rendering:run
yarn website:build
git diff --check
```

After a build, `test-rendering:run` avoids rebuilding for GPU iteration.
`test-fast` runs lint and Node tests; `test` runs lint, Node and headless tests.
Always run `lint:fix` after edits and inspect its changes before committing.
Do not run different Vitest/Vite configurations concurrently in one checkout:
dependency re-optimization can reload test pages. Do not rebuild while
packaged-worker rendering tests run.

## Build and artifact contracts

Ocular/esbuild produce renderer ES modules and an embedded scene-worker Blob.
A small renderer adapter handles GLSL text, worker embedding, core isolation and
multi-output watching. The layer's main, projected and WebXR entries use
`ocular-bundle`; the renderer stays an external package boundary.

All `dist/` output is generated and ignored, including declarations, schemas
and worker sidecars. The private packages' `prepack` hooks rebuild it. There are
no classic-script `tangram.debug.js` or `tangram.min.js` outputs; standalone
browser examples import `tangram.debug.mjs`. Worker IIFEs are intentional
self-contained worker scripts, not application UMD bundles.

Build the renderer before the layer. Optional worker graphs must not require
prebuilt layer output or import deck.gl. Clean-checkout CI builds the website,
packs the renderer and checks all required artifacts without committed bundles.

## Website and examples

```sh
yarn website:start --host 127.0.0.1 --port 3000
# Or preview a production build:
yarn website:build
yarn workspace tangram-layers-website serve --host 127.0.0.1 --port 3000
```

Open `http://127.0.0.1:3000/tangram.gl/`. Asset assembly builds the packages and
classic playground, copies assets, and leaves Docusaurus in control of example
routes. Standalone `index.html` files are deliberately not copied over those
routes. Example canvases resize beside the sidebar; info cards can collapse
without discarding editor/control state, and fullscreen stays inside the example.

For standalone examples, run `yarn build`, then `yarn start`: the renderer watch
command serves the repository at `http://127.0.0.1:8000/` (override with `PORT`).
It watches renderer bundles only; rebuild layer or playground output after
changing those sources. The classic workspace also has
`yarn workspace @vis.gl/tangram-classic start`, which builds its prerequisites.

The canonical public host is [vis.gl/tangram.gl](https://vis.gl/tangram.gl/).
This repository validates the website but does not deploy GitHub Pages.
Publication is managed separately; a merge here is not a Pages deployment.

### Playground and worker pitfalls

- Use the controlled community editor `value`; changing `defaultValue` or only
  a nested panel definition does not replace the visible document.
- Serialize scene loads, preserve the selected style's resource base, and cancel
  obsolete queued edits/source requests. Cancellation does not roll back an
  already-running scene load.
- Keep the Monaco editor and same-origin worker versions matched. The classic
  build bundles editor/JSON workers; browser test commands build them too.
  Never construct a Worker directly from a cross-origin CDN URL.
- Serve standalone pages and sidecars over HTTP(S), not `file://`. See
  [projected workers](../developer-guide/projected-basemaps.md#usage) for asset
  URLs and [attribution](../developer-guide/tile-providers.md) for credit UI.

## Types and behavior-preserving changes

TypeScript uses strict checking with bundler resolution. Suppressed lifecycle
files are tracked in `scripts/typescript-suppression-allowlist.json`; remove
entries as files become checked, never add suppressions to bypass errors.
Internal contracts are not automatically public API exports.

Keep authored values `unknown` until normalized. Distinguish source data,
style/build identities, worker payloads and GPU descriptors. Use `declare`
for inherited/prototype class fields so annotations do not create shadowing
runtime properties. Local assertions must describe real normalization boundaries,
not bypass them. Preserve parsing order, lazy caches, units, packed byte offsets,
transfer ownership and cancellation semantics. Logic changes need separate
regression evidence. See `AGENTS.md` for repository-wide architecture and provenance rules.

## Tests and coverage

Use native Vitest APIs for new or substantially revised tests. Node tests use
`*.node.spec.*`; Chromium tests use `*.browser.spec.*`. Existing Chai/Sinon
helpers serve the inherited compatibility suite; do not add another runner.
Use small deterministic fixtures, not live CDNs or tile services.

CI collects Node and Chromium coverage blobs, merges them, and enforces separate
module gates before uploading to Coveralls and the `module-coverage` artifact.
Neither package can hide a regression in the other. The committed gates are:

| Module | Statements | Branches | Functions | Lines |
| --- | ---: | ---: | ---: | ---: |
| Renderer | 78% | 69% | 82% | 78% |
| Layers | 92% | 90% | 95% | 94% |

The source of truth is `scripts/coverage-modules.mjs`. Coverage includes all
authored source, including experimental entries and unexecuted files; generated,
vendored, declaration and test files are outside the denominator.
`yarn test-coverage` is a **browser-only**, incomplete report. Do not use it
as the final merged percentage.

Set `TANGRAM_COVERAGE_ENFORCE=1` only when merging Node and Chromium reports,
as in `.github/workflows/test.yml`. `yarn coverage:scope` audits a generated
merged report against the authored source inventory. Never lower a threshold
or exclude untested source to pass a check.

## Rendering and interaction regressions

`test/rendering/*.render.spec.ts` uses packaged entries, real Chromium software
GPU devices and generated workers. Public network requests and unexpected
browser/GPU errors fail the lane; an unavailable selected backend fails rather
than silently falling back.

Fixtures cover Map/Globe/FirstPerson views, projected geometry, mono/stereo eyes,
animation, resize, source overzoom, mouse/trackpad/touch input and WebGL selection.
WebGPU feature selection remains explicitly unsupported. Pixel properties and
image differences avoid platform-specific golden images; they do not guarantee
every historical style's visual parity.

CI exposes separate **Rendering (webgl)** and **Rendering (webgpu)** checks.
Artifacts `rendering-webgl` / `rendering-webgpu` include PNGs, diagnostics and
JUnit results. Local `screenshots/rendering/` output must not be committed.
Generated-bundle rendering does not inflate authored-source coverage.

Run both backends for GPU, projection, visibility or interaction changes.
Software GPU tests, synthetic trackpad input and mocked XR frames do not replace
hardware browser, physical trackpad or headset validation. Report those checks
separately before a release.
