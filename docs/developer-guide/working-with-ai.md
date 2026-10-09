{/*
tangram-layers
SPDX-License-Identifier: MIT
Copyright (c) vis.gl contributors
 */}

# Working with AI agents

Start with the checked-out version and a result you can observe in a browser.
tangram.gl is experimental; both module packages are private workspaces, not
npm releases. Current website documentation may be newer than your checkout.

## Fetch focused documentation

The website publishes [llms.txt](https://vis.gl/tangram.gl/llms.txt), an index of
current documentation with absolute links to rendered Markdown pages. Fetch
only the pages relevant to the task, for example:

- [Getting started](https://vis.gl/tangram.gl/docs/get-started/getting-started.md)
- [TangramLayer](https://vis.gl/tangram.gl/docs/api-reference/tangram-layer.md)
- [Renderer](https://vis.gl/tangram.gl/docs/api-reference/renderer.md)
- [HostFrame](https://vis.gl/tangram.gl/docs/api-reference/host-frame.md)
- [Styling](https://vis.gl/tangram.gl/docs/api-reference/styling.md)

These files are generated from the rendered documentation, including YAML/JSON
and language tabs, rather than exposing unprocessed MDX. Live examples are
excluded from the index; use the [examples](/tangram.gl/examples) for visual
verification. A monolithic `llms-full.txt` is intentionally not generated.

`llms.txt` helps an agent select documentation. It is not crawler access control,
a training opt-out or a replacement for versioned source and declarations.

## Establish local truth

Ask the agent to inspect the checkout, lockfile, package exports and TypeScript
declarations before using an API. Build the workspace before inspecting generated
`dist/types` declarations. Do not infer that a sample works with another release.

Choose the correct boundary:

- **deck.gl basemaps:** `@vis.gl/tangram-layers`; deck.gl owns the view,
  controller, device, render pass and frame scheduling.
- **Custom hosts:** `@vis.gl/tangram-renderer/core`; feed camera and pass state
  through [HostFrame](../api-reference/host-frame.md).
- **Classic scenes:** the renderer root and example-local Leaflet adapter.
- **Projected basemaps or WebXR:** the explicit experimental layer subpaths;
  check their documented limitations before promising support.

Keep the renderer independent of deck.gl and Leaflet. Preserve Tangram's scene
syntax and provider attribution; changing tile formats or projection must not
silently change styling semantics.

## Verify observable behavior

A successful typecheck does not prove that a basemap renders. Give the agent a
specific scene, view, backend and success condition:

> Render the local TRON scene with MapView on WebGL 2 and WebGPU. Verify that
> tiles load, roads animate, navigation works and attribution remains visible.
> Report failed requests, console or shader errors, and a rendered screenshot.

Serve examples over HTTP(S), not `file://`. Confirm that the canvas has a usable
device, workers load from the correct origin, tile requests succeed, and the
scene builds geometry before changing shaders. Test each intended backend and
view independently. Stereo preview is not proof of immersive headset support.
State which environments were tested and which require hardware validation.

## Repository changes

Read the root `AGENTS.md` before editing. Use the project's Ocular commands,
strict TypeScript and native Vitest tests. Follow the
[development workflow](../contributor-guide/development.md) for the required
build, lint, browser and rendering gates. Do not commit generated bundles,
weaken coverage gates, or replace legacy procedures without conformance evidence.

`yarn website:build` generates the index and Markdown, normalizes the deployment
subpath, and checks required pages, MDX extraction and local Markdown links.
The generated files travel with the website build; they are not checked in.
