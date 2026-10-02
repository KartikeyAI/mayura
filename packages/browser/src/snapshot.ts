/** A node of `Accessibility.getFullAXTree`, as far as snapshots read it. */
export interface AxNode {
  readonly nodeId: string;
  readonly ignored?: boolean;
  readonly role?: { readonly value?: unknown };
  readonly name?: { readonly value?: unknown };
  readonly value?: { readonly value?: unknown };
  readonly properties?: readonly { readonly name: string; readonly value?: { readonly value?: unknown } }[];
  readonly childIds?: readonly string[];
  readonly parentId?: string;
  readonly backendDOMNodeId?: number;
}

/** Roles a person acts on: each gets a ref the action tools take. */
const interactive = new Set(['button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'listbox', 'option',
  'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'switch', 'slider', 'spinbutton', 'treeitem', 'textarea', 'ComboBox', 'MenuListPopup']);
/** Roles that only group others: shown through their children. */
const structural = new Set(['none', 'generic', 'presentation', 'InlineTextBox', 'LineBreak', 'RootWebArea', 'WebArea', 'Iframe', 'IframePresentational', 'group', 'Section', 'LayoutTable', 'LayoutTableRow', 'LayoutTableCell']);
const shownStates = ['checked', 'pressed', 'selected', 'expanded', 'disabled', 'required', 'invalid', 'focused'] as const;

const text = (value: unknown, max: number) => (typeof value === 'string' || typeof value === 'number' ? String(value).replace(/\s+/gu, ' ').trim().slice(0, max) : '');
const quoted = (value: string) => JSON.stringify(value);

export interface SnapshotOutline {
  readonly text: string;
  readonly truncated: boolean;
  /** Each ref's DOM node, by backend node id. */
  readonly refs: ReadonlyMap<string, number>;
}

/**
 * An outline of a page from its accessibility tree: one line per meaningful node, indented by depth, with `[ref=eN]` on
 * the ones that can be acted on. At most `maxBytes` of UTF-8; refs are numbered from `firstRef`.
 */
export function outline(nodes: readonly AxNode[], maxBytes: number, firstRef = 1): SnapshotOutline {
  const byId = new Map(nodes.map(node => [node.nodeId, node]));
  const root = nodes.find(node => node.parentId === undefined || !byId.has(node.parentId));
  const lines: string[] = []; const refs = new Map<string, number>(); let next = firstRef; let bytes = 0; let truncated = false;
  const encoder = new TextEncoder();
  const visit = (node: AxNode, depth: number, parentName: string, seen: Set<string>, level: number) => {
    // Pages nested deeper than this are cut off there, rather than overflowing the stack.
    if (truncated || seen.has(node.nodeId) || level > 1_000) return; seen.add(node.nodeId);
    const role = text(node.role?.value, 64); const name = text(node.name?.value, 200);
    let childDepth = depth; let nameForChildren = parentName;
    const shown = !node.ignored && !(structural.has(role) && !(interactive.has(role)))
      && !(role === 'StaticText' && (name === '' || name === parentName));
    if (shown) {
      const states = shownStates.flatMap(state => {
        const value = node.properties?.find(property => property.name === state)?.value?.value;
        return value === true || value === 'true' ? [state] : value === 'mixed' ? [`${state}=mixed`] : [];
      });
      const value = text(node.value?.value, 200);
      const actionable = node.backendDOMNodeId !== undefined && (interactive.has(role)
        || node.properties?.some(property => property.name === 'focusable' && property.value?.value === true) === true && name !== '');
      let line = role === 'StaticText' ? `${'  '.repeat(depth)}- text ${quoted(name)}` : `${'  '.repeat(depth)}- ${role}${name ? ` ${quoted(name)}` : ''}`;
      if (value && value !== name) line += ` value=${quoted(value)}`;
      for (const state of states) line += ` [${state}]`;
      const ref = actionable ? `e${next}` : undefined;
      if (ref) line += ` [ref=${ref}]`;
      const size = encoder.encode(line).byteLength + 1;
      if (bytes + size > maxBytes) { truncated = true; return; }
      // A ref counts only once its line is shown.
      if (ref) { refs.set(ref, node.backendDOMNodeId!); next++; }
      lines.push(line); bytes += size; childDepth = depth + 1; nameForChildren = name;
    }
    for (const childId of node.childIds ?? []) {
      const child = byId.get(childId);
      if (child) visit(child, childDepth, nameForChildren, seen, level + 1);
    }
  };
  if (root) visit(root, 0, '', new Set(), 0);
  return { text: lines.join('\n'), truncated, refs };
}
