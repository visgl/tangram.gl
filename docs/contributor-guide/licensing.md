{/*
tangram-layers
SPDX-License-Identifier: MIT
Copyright (c) vis.gl contributors
 */}

# Licensing and attribution

The repository is licensed under the MIT License. Source files use SPDX
headers so package consumers and automated compliance tools can identify the
license without inferring it from the repository layout.

## Copyright lines

Code, tests, shaders, demo sources, and documentation inherited from the
original Tangram repository retain its copyright notice:

```text
SPDX-License-Identifier: MIT
Copyright (c) 2013-2016 Brett Camper and Mapzen
```

Files first created for this vis.gl custodian fork use:

```text
SPDX-License-Identifier: MIT
Copyright (c) vis.gl contributors
```

The distinction is based on file provenance, not on the current directory. A
modernized original renderer file continues to credit Tangram even when it has
subsequently been modified by vis.gl contributors.

## Enforcement

Run `yarn lint:licenses` to check all tracked project text formats that support
comments. Run `yarn lint:licenses:fix` to add missing headers or repair
incorrect attribution using the repository's provenance rules. The normal
`yarn lint` and `yarn lint:fix` commands include these checks.

Generated JavaScript bundles receive the same headers from their esbuild or
generation configuration so a rebuild does not discard attribution. JSON,
source maps, lockfiles, binary assets, and data fixtures cannot safely carry
comments and are covered by the repository or package license metadata.

Files under `examples/classic/lib/` are preserved third-party distributions.
Their upstream copyright and license notices remain authoritative and the
repository header tool intentionally does not rewrite them.
