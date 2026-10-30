{/*
tangram-layers
SPDX-License-Identifier: MIT
Copyright (c) vis.gl contributors
 */}

# npm publishing preparation

The intended public packages are `@tangram.gl/tangram-renderer`,
`@tangram.gl/tangram-layers`, and `@tangram.gl/basemap-layers`. Their initial
version was `0.0.0`. Merging a release preparation does not publish anything.

Before each release, review each package's `yarn pack` output and run the
package-consumer checks.
The `@tangram.gl/tangram-renderer` and `@tangram.gl/tangram-layers` package
entries can be imported in Node and SSR without browser globals. Rendering
still requires a supported browser and GPU; test the packed artifacts in
consumer environments before release.
The three package manifests must be public. Example and development workspaces
must remain private.

Configure each package's trusted publisher to use GitHub owner `visgl`,
repository `tangram.gl`, workflow filename `publish.yml`, and environment `npm`,
with the publish permission enabled. Configure appropriate reviewers or other
protection for the GitHub `npm` environment.

For subsequent versions, update all three manifests and the lockfile together,
verify CI and the packed artifacts, then manually dispatch **Publish npm
packages** on `master`, supplying the exact version and confirmation `publish`.
The workflow uses npm's OIDC trusted publishing, not a long-lived npm token.
Publishing is not atomic: if a later package fails, inspect which versions were
published before retrying the remaining packages. npm does not allow
republishing a version. Use `yarn workspace <package-name> pack --out
<absolute-tarball-path>` to inspect a package with resolved workspace ranges.

See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) for
the current npm-side setup and authentication requirements.
