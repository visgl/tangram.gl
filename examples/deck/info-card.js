// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

const cards = new WeakMap();

/** Add an accessible disclosure without replacing controls or losing selected tabs. */
export function createCollapsibleInfoCard(panel) {
  if (!panel || !panel.querySelector('h1')) return () => {};
  if (cards.has(panel)) return cards.get(panel);
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'info-card-toggle';
  panel.setAttribute('data-info-card', '');
  const update = () => {
    const collapsed = panel.classList.contains('info-card-collapsed');
    button.setAttribute('aria-expanded', String(!collapsed));
    button.setAttribute('aria-label', `${collapsed ? 'Expand' : 'Collapse'} information panel`);
    button.title = `${collapsed ? 'Expand' : 'Collapse'} information panel`;
    button.textContent = collapsed ? '+' : '−';
  };
  const toggle = () => {
    panel.classList.toggle('info-card-collapsed');
    update();
  };
  button.addEventListener('click', toggle);
  panel.append(button);
  update();
  const destroy = () => {
    if (cards.get(panel) !== destroy) return;
    button.removeEventListener('click', toggle);
    button.remove();
    panel.classList.remove('info-card-collapsed');
    panel.removeAttribute('data-info-card');
    cards.delete(panel);
  };
  cards.set(panel, destroy);
  return destroy;
}
