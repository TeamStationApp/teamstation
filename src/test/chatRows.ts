/**
 * How the end-to-end suites find a chat in the Chat tab's list by its
 * title. A row is one button whose name is everything it shows, joined
 * with commas: `<title>`, then its latest message and its unread count
 * when it has them (`ChatListScreen`), so a row is matched by its title as
 * the leading part of its name, never by the whole name. Where a suite has
 * the conversation's id, its `chat-conversation-<id>` test id is the surer
 * handle.
 */

/** `text` inside a double-quoted CSS attribute value. */
function cssString(text: string): string {
  return text.replace(/["\\]/g, '\\$&').replace(/\n/g, '\\a ')
}

/** `text` matched literally inside a regular expression. */
function regexLiteral(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * A CSS selector for the web row of the chat titled `title`: a button
 * named exactly the title (a chat with nothing new), or the title followed
 * by `, ` and what else the row shows. `within` scopes it, e.g. to the
 * list's `[data-testid="chat-conversation-list"]`.
 */
export function chatRowSelector(title: string, within = ''): string {
  const quoted = cssString(title)
  const scope = within === '' ? '' : `${within} `
  return [
    `${scope}[role="button"][aria-label="${quoted}"]`,
    `${scope}[role="button"][aria-label^="${quoted}, "]`
  ].join(', ')
}

/**
 * A maestro `text` pattern for the native row of the chat titled `title`.
 * iOS exposes the row as one element named `title, preview, unread`, so the
 * title is matched as its leading part. Android keeps the title's own text
 * node inside the row, which is matched whole, as chat2.e2e matches a
 * preview there.
 */
export function chatRowText(
  title: string,
  platform: 'ios' | 'android'
): string {
  const literal = regexLiteral(title)
  return platform === 'ios' ? `^${literal}(, .+)?$` : `^${literal}$`
}

/** The selector of a conversation's row on the web, by its id. */
export function chatRowById(conversationId: string): string {
  return `[data-testid="chat-conversation-${cssString(conversationId)}"]`
}

/** A rectangle of the native accessibility hierarchy, in screen points. */
export interface NativeBounds {
  x: number
  y: number
  width: number
  height: number
}

/** What `nativeRowInList` reads of a native hierarchy node. */
export interface NativeNode<T> {
  type?: string
  bounds?: NativeBounds
  children?: T[]
}

function nativeNodes<T extends NativeNode<T>>(node: T | T[]): T[] {
  if (Array.isArray(node)) return node.flatMap(nativeNodes)
  return [node, ...(node.children ?? []).flatMap(nativeNodes)]
}

/**
 * A chat row in a native hierarchy and the list it scrolls in: the first
 * node with bounds that `isRow` picks, and the first ScrollView with bounds
 * whose subtree holds that very node. The list is found by the row node
 * itself, not by its `chat-conversation-<id>`, so a legacy build whose
 * rows carry no id gets the list the row is in, not just any ScrollView.
 * Undefined until both are there.
 */
export function nativeRowInList<T extends NativeNode<T>>(
  tree: T | T[],
  isRow: (node: T) => boolean
): { row: T & { bounds: NativeBounds }; viewport: NativeBounds } | undefined {
  const nodes = nativeNodes(tree)
  const row = nodes.find(
    (node): node is T & { bounds: NativeBounds } =>
      node.bounds != null && isRow(node)
  )
  if (row == null) return undefined
  const viewport = nodes.find(
    node =>
      node.type?.includes('ScrollView') === true &&
      node.bounds != null &&
      nativeNodes(node).includes(row)
  )?.bounds
  if (viewport == null) return undefined
  return { row, viewport }
}
