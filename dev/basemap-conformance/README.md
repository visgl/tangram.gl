<!--
tangram-layers
SPDX-License-Identifier: MIT
Copyright (c) vis.gl contributors
-->

# Basemap conformance test helpers

This test-only snapshot comes from `dev/basemap-conformance/src` in
deck.gl-community commit `d903803f56f5eccda88a9b4328ab266c98c55fe5`, the same
revision as the imported basemap tests. It keeps the tests' metrics and browser
renderer available without fetching code during required checks. The separate
report-only Tangram conformance workflow uses its own explicitly pinned checkout.
Keep the two harnesses aligned when updating the copied basemap tests.
