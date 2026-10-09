<!--
Tangram
SPDX-License-Identifier: MIT
Copyright (c) 2013-2016 Brett Camper and Mapzen
Copyright (c) 2026 vis.gl contributors
-->

# Contributing to tangram.gl

The renderer lives in `modules/tangram-renderer`, the deck.gl adapter in
`modules/tangram-layers`, and applications in `examples/`. Workspaces are
private; generated bundles and schemas must not be committed.

## Start locally

Use the Node version in `.nvmrc` and Yarn version in `package.json`:

```sh
corepack enable
yarn install --immutable
yarn website:start --host 127.0.0.1 --port 3000
```

Open `http://127.0.0.1:3000/tangram.gl/`. The website command builds required
example assets. For the standalone deck example, run `yarn build`, then
`yarn start` and open `http://localhost:8000/examples/deck/`.

## Validate changes

```sh
yarn build
yarn typecheck
yarn lint:fix
yarn lint
yarn test-node
yarn test-headless
git diff --check
```

New tests use Vitest. Chromium is required for browser coverage; install it with
`yarn playwright:install`. GPU changes also require WebGL and WebGPU rendering
tests; docs/example changes require `yarn website:build`. Build, bundling and
formatting use `@vis.gl/dev-tools` / Ocular, not a separate Rollup pipeline.

## Pull requests

Keep the renderer independent of deck.gl and Leaflet. Preserve Tangram's source
and styling conventions, add regression coverage for behavior changes, and
document public APIs. Retain upstream copyright notices and add vis.gl
modification attribution where appropriate.

Push branches directly to `visgl/tangram.gl`. Describe goals, actual changes
and validation; keep the branch current with master. Address review threads
and verify required CI/coverage on the latest revision before requesting merge.

See the [Contributor Guide](docs/contributor-guide/development.md) for rendering,
workers, coverage and build contracts, and [AGENTS.md](AGENTS.md) for agent workflow.
