{/*
tangram-layers
SPDX-License-Identifier: MIT
Copyright (c) vis.gl contributors
 */}

# Release workflow

Tangram layers follows the version-only-first release flow used by vis.gl
repositories. Release commands are intentionally available only from the root,
so all workspace versions and the lockfile are updated together.

```sh
yarn lint:fix
yarn build
yarn test
yarn publish:beta
# or, for a stable release:
yarn publish:prod
```

Review the generated version changes before publishing. The renderer and layer
packages are currently alpha releases; a future public API change should use an
appropriate major version bump and include an entry in `CHANGELOG.md`, the
upgrade guide, and the relevant package documentation.

Before publishing, verify the package entrypoints, generated worker bundles,
website examples, and the release notes on the intended branch.
