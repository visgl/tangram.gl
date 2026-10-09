{/*
tangram-layers
SPDX-License-Identifier: MIT
Copyright (c) vis.gl contributors
 */}

# Release workflow

All workspaces are currently `private: true` and unpublished. The scripts below
prepare version changes; they are **not** an npm publication path for private
packages.

## Before a release

1. Decide which packages may be published; do not remove `private` incidentally.
2. Update `CHANGELOG.md`, release notes and affected API documentation. Put
   deleted/deprecated behavior in the upgrade guide.
3. Run build, typecheck, lint, Node/Chromium tests, both GPU backends and the website
   build. Check generated exports, declarations, schemas and worker assets.
4. Inspect packed contents: `prepack` rebuilds `dist/` from source. Keep generated
   files out of Git.
5. Establish and verify the authorized npm/GitHub release workflow before publishing.

The root commands use Ocular's version-only modes:

```sh
yarn publish:beta  # ocular-publish version-only-beta
yarn publish:prod  # ocular-publish version-only-prod
```

Review resulting manifest/lockfile changes. A command's name is not evidence that
an artifact was published; verify the release workflow and registry explicitly.

## Branches and website

`9.4-release` preserves the earlier dependency stack; development targets `master`.
Backport compatible fixes deliberately, without upgrading the release branch as
an incidental step.

The canonical website is [vis.gl/tangram.gl](https://vis.gl/tangram.gl/).
This repository validates its build but does not deploy GitHub Pages. Publication
is managed by the canonical host; merging here does not trigger a Pages deployment.
