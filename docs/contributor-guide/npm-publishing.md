{/*
tangram-layers
SPDX-License-Identifier: MIT
Copyright (c) vis.gl contributors
 */}

# npm publishing preparation

The intended public packages are `@tangram.gl/tangram-renderer`,
`@tangram.gl/tangram-layers`, and `@tangram.gl/basemap-layers`. Their initial
version is `0.0.0`. They remain private while package artifacts and consumers
are validated; merging this preparation does not publish anything.

Before the first release, an npm organization administrator must confirm that
the `tangram.gl` scope exists and the publisher has the necessary permissions.
Review each package's `yarn pack` output and run the package-consumer checks.
Then explicitly set `private` to `false` in each package in a reviewed release
change. Example and development workspaces must remain private.

npm currently requires a package to exist before a trusted publisher can be
configured. An authorized maintainer must publish the initial version of each
package using an npm account and the organization's required authentication,
in renderer, tangram-layers, basemap-layers order. Do not commit credentials.
Use `yarn workspace <package-name> pack --out <absolute-tarball-path>` so Yarn
resolves workspace dependency ranges in the packed manifest, followed by
`npm publish <absolute-tarball-path> --access public`. Check every tarball
before publishing. Publishing is not atomic: if a later package fails, inspect
which versions were published before retrying the remaining packages.
Configure each package's trusted publisher to use GitHub owner `visgl`,
repository `tangram.gl`, workflow filename `publish.yml`, and environment `npm`,
with the publish permission enabled. Configure appropriate reviewers or other
protection for the GitHub `npm` environment.

For subsequent versions, update all three manifests and the lockfile together,
verify CI and the packed artifacts, then manually dispatch **Publish npm
packages** on `master`, supplying the exact version and confirmation `publish`.
The workflow uses npm's OIDC trusted publishing, not a long-lived npm token.
The first version is already published during bootstrap, so do not dispatch it
again for that same version. npm does not allow republishing a version.

See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) for
the current npm-side setup and authentication requirements.
