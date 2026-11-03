/** How many rows a home section shows before More. */
export const HOME_LIST_PREVIEW = 5

export interface HomeListWindow<T> {
  rows: T[]
  /** The list is longer than the preview, so More or Less is shown. */
  toggle: boolean
  /** Less is the control: the stored flag is on and there is more than the preview. */
  expanded: boolean
}

/**
 * The rows a home section draws.
 *
 * Five, unless the section is expanded. A list of five or fewer is the whole
 * list and has no control. The order is the one the server already returned.
 */
export function windowHomeList<T>(
  rows: readonly T[],
  expanded: boolean
): HomeListWindow<T> {
  const toggle = rows.length > HOME_LIST_PREVIEW
  const open = expanded && toggle
  return {
    rows: open ? [...rows] : rows.slice(0, HOME_LIST_PREVIEW),
    toggle,
    expanded: open
  }
}
