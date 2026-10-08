<!--
tangram-layers
SPDX-License-Identifier: MIT
Copyright (c) vis.gl contributors
-->

# AGENTS.md

## Repository and setup

- The canonical repository is `visgl/tangram.gl`. Push branches directly there,
  not through a personal fork. Use `codex/` for new branches unless requested otherwise.
- Use the Node version in `.nvmrc` and the Yarn version in `package.json`.
- Install dependencies with `yarn install --immutable`. For intentional dependency
  changes, run `yarn install` and commit the updated manifests and lockfile together.
- Use `@vis.gl/dev-tools` / Ocular for shared build, lint and test orchestration;
  do not introduce a parallel toolchain for functionality it already provides.
- Keep workspaces private unless publishing is explicitly requested. Do not change
  package versions, publish packages or modify `9.4-release` as an incidental step.

## Validation commands

Use the exact scripts from the root `package.json`:

```sh
yarn build             # complete module and classic-example build
yarn typecheck         # strict TypeScript check without emitting files
yarn lint:fix          # license headers and safe Biome formatting fixes
yarn lint              # license, formatting and TypeScript-scope checks
yarn test-node         # Node Vitest suite
yarn test-headless     # build workers and run Chromium Vitest suite
yarn test-rendering    # build modules and run WebGL rendering regressions
TANGRAM_TEST_DEVICE=webgpu yarn test-rendering
yarn website:build     # assemble assets and build the production website
yarn coverage:scope    # audit a previously generated merged coverage report
git diff --check
```

- Always run `yarn lint:fix` after edits and inspect its changes before committing.
- After source, test or build changes, run build, typecheck, lint, Node and headless
  tests after the final edits. Run both rendering backends for GPU, projection,
  camera, tile-selection or interaction changes. Build the website for docs,
  example, asset or public-API changes.
- For documentation-only changes, local license/lint and whitespace checks are
  sufficient; the latest-head CI checks must still pass before declaring readiness.
- Never commit generated `dist`, `build`, coverage, screenshot or website assets.
  Generated schemas and package entries are recreated by builds and `prepack`.
- See `docs/contributor-guide/development.md` and `.github/workflows/test.yml`
  for build contracts and the exact merged-coverage workflow.

## Architecture, types and attribution

- Keep `tangram-renderer` independent of deck.gl. Deck views and WebXR adapters
  belong in `tangram-layers`; `HostFrame` must not contain deck/WebXR-specific state.
- Leaflet integration belongs in the example, not the renderer core package.
- Preserve Tangram's styling, shader blocks, source conventions and compatibility
  contracts. Encapsulate legacy procedures and compare identical fixtures before
  switching to vis.gl implementations. Keep dependency and bundle impact explicit.
- Use strict TypeScript, descriptive names, narrow interfaces and TSDoc for new
  public classes, functions, methods and fields. Do not add unchecked directives
  or broad assertions to bypass errors; shrink the suppression allowlist.
- Use explicit named exports. Do not use `export *`; prefer re-exports only in
  the top-level `index.ts` of each module. Follow the repository's formatting and
  preserve semicolons.
- Retain Brett Camper / Mapzen notices in inherited code. Substantive vis.gl
  modifications also retain a vis.gl modification notice; genuinely new files
  use vis.gl attribution, not inherited authorship. Maintain the provenance sets
  in `scripts/check-license-headers.mjs` and verify `yarn lint:licenses`.

## Tests, workers and coverage

- Write new and substantially revised tests with native Vitest APIs (`test`,
  `describe`, `expect`, lifecycle hooks and `vi`). Do not add Chai/Sinon usage or
  another test runner. Existing compatibility helpers can be removed incrementally.
- Use `*.node.spec.*` for Node tests and `*.browser.spec.*` for Chromium tests;
  GPU/interaction conformance belongs under `test/rendering/`.
- Prefer small deterministic fixtures, boundary coverage and observable behavior.
  Required tests must not depend on live tile services or CDNs.
- Build before testing packaged entries and workers. `yarn test-headless` builds
  the renderer test worker and same-origin Monaco workers automatically.
- Do not run different Vitest/Vite configurations concurrently in one checkout:
  dependency re-optimization can reload pages and invalidate browser tests. Do not
  rebuild website/module assets while packaged-worker rendering tests are running.
- Keep Monaco editor and worker versions matched; do not use cross-origin worker
  URLs. Keep worker bundles valid in packages, standalone examples and the website.
- Coverage includes all authored source in both modules, including experimental
  entries and unexecuted files. Merge Node and browser blobs before enforcing the
  independent module gates. A single runtime's report is not the final report.
- Never lower coverage thresholds, remove source from the denominator, or add
  exclusions to make a check pass. Generated/vendor/declaration exclusions need
  a documented reason. Update source inventory tests when authored files change.

## GitHub and babysitting pull requests

- If `gh` authentication fails, check for an authenticated GitHub connector before
  treating GitHub access as blocked. Preserve unrelated local changes.
- PR descriptions must have real Markdown newlines, begin with goals, describe
  actual changes relative to the base, and report validation and limitations.
- After opening a PR, or when asked to address reviews or babysit it, own the work
  until the latest revision is ready for merge. Pushing fixes is not completion.
- Allow at least 15 minutes after opening a PR for reviews, as in loaders.gl and
  luma.gl. Use that time to inspect CI, coverage and the diff, and fix findings.
  Use bounded waits and keep the user informed; do not busy-poll unchanged checks.
- Close every actionable review thread: inspect the evidence, implement the fix,
  add focused regression coverage where appropriate, verify the final revision,
  reply with what changed and how it was tested, then resolve the thread. If a
  finding is incorrect or outside scope, explain why; do not silently dismiss it.
- Recheck for new review comments after each push. Check both inline threads and
  top-level review/issue comments; a green review check alone is not sufficient.
- Keep the branch current with remote `master`, resolve conflicts safely, and
  recheck mergeability after each push. Regenerate conflicting generated output
  from combined sources rather than selecting an arbitrary side.
- Inspect every required CI check and coverage gate on the latest head commit.
  Investigate failures; rerun transient jobs only when supported by evidence.
  Older green runs and local/focused tests do not replace latest-head green CI.
- Before finishing, recheck remote master, review threads, mergeability, the
  current head's checks and the PR description. Do not declare readiness with
  actionable unresolved comments, failed checks or pending required checks.
- Report the PR link, review fixes, verification and remaining blockers. Resolve
  comments without closing the PR. Do not merge unless the user explicitly asks.
