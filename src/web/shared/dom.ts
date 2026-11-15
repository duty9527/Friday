export function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing interface element: ${id}`);
  return found as T;
}

export function node<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = ''): HTMLElementTagNameMap[K] {
  const result = document.createElement(tag);
  result.textContent = text;
  if (className) result.className = className;
  return result;
}

export function button(text: string, action: () => void, className = ''): HTMLButtonElement {
  const result = node('button', text, className);
  result.type = 'button';
  result.addEventListener('click', action);
  return result;
}

export function svgNode<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string> = {}): SVGElementTagNameMap[K] {
  const result = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attrs)) result.setAttribute(key, value);
  return result;
}

export function kpiCard(label: string, value: string, sub = '', tone: 'default' | 'accent' | 'positive' | 'warning' = 'default'): HTMLElement {
  const card = node('div', '', `hub-kpi-card tone-${tone}`);
  card.append(
    node('span', label, 'hub-kpi-label'),
    node('strong', value, 'hub-kpi-value'),
  );
  if (sub) card.append(node('span', sub, 'hub-kpi-sub meta'));
  return card;
}

/**
 * Returns true if the active document focus is inside a user-editable field within `container`,
 * used to prevent SSE background refreshes from interrupting typing or wiping unsaved form state.
 */
export function isEditingWithin(container: Element): boolean {
  const activeEl = document.activeElement;
  if (!(activeEl instanceof HTMLElement) || !container.contains(activeEl)) return false;
  return activeEl instanceof HTMLInputElement
    || activeEl instanceof HTMLTextAreaElement
    || activeEl instanceof HTMLSelectElement
    || activeEl.isContentEditable;
}
