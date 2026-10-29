// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

// deck.gl-community
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/** Mounts an example into a supplied container. */
export type ExampleMount<Props = unknown> = (
  container: HTMLElement,
  props?: Props
) => void | (() => void) | Promise<void | (() => void)>;

/** Resolves and sizes the host element for a standalone example. */
export function getStandaloneExampleContainer(id = 'app'): HTMLElement {
  let container = document.getElementById(id);
  if (!(container instanceof HTMLElement)) {
    container = document.createElement('div');
    container.id = id;
    document.body.appendChild(container);
  }
  document.documentElement.style.height = '100%';
  document.body.style.margin = '0';
  document.body.style.height = '100%';
  container.style.width = '100vw';
  container.style.height = '100vh';
  return container;
}

/** Runs an example against a standalone host. */
export function mountStandaloneExample<Props = unknown>(mount: ExampleMount<Props>, props?: Props) {
  return mount(getStandaloneExampleContainer(), props);
}
