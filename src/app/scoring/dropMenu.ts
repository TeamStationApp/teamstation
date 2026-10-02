import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * The phone's More and Ball in Play menus, as the web's behave: a tap opens
 * the options above the button; a press dragged up opens them under the
 * finger, highlights the row it is over, opens a row's submenu as it passes,
 * and chooses on release. This is the part with no view in it — positions
 * come in as window coordinates, from the gesture and from each row's own
 * measurement — so the adapters (`MoreMenu.native`, `OutcomePicker.native`)
 * are only wiring.
 */
export interface DropRect {
  x: number
  y: number
  width: number
  height: number
}

/** How far up a press travels before it is a drag, as on the web. */
export const DRAG_OPEN_PX = 8

export function inDropRect(
  rect: DropRect | undefined,
  x: number,
  y: number
): boolean {
  return (
    rect != null &&
    x >= rect.x &&
    x <= rect.x + rect.width &&
    y >= rect.y &&
    y <= rect.y + rect.height
  )
}

export function dropRowAt(
  rows: ReadonlyMap<string, DropRect>,
  x: number,
  y: number
): string | undefined {
  for (const [key, rect] of rows) if (inDropRect(rect, x, y)) return key
  return undefined
}

/**
 * Whether a drag has left the menu for good — the More menu's escape. It has
 * not while it is over either panel, crossing the gap between them, or still
 * travelling up from the button to the panel's bottom edge.
 */
export function leftDropMenu(
  point: { x: number; y: number },
  startY: number,
  parent: DropRect | undefined,
  child: DropRect | undefined
): boolean {
  if (parent == null || parent.width <= 0) return false
  const { x, y } = point
  if (inDropRect(parent, x, y) || inDropRect(child, x, y)) return false
  const bridge =
    child != null &&
    y >= child.y &&
    y <= child.y + child.height &&
    ((x >= parent.x + parent.width && x <= child.x) ||
      (x >= child.x + child.width && x <= parent.x))
  const approach =
    x >= parent.x &&
    x <= parent.x + parent.width &&
    y > parent.y + parent.height &&
    y <= startY
  return !bridge && !approach
}

export interface DropMenuOptions {
  disabled: boolean
  /** The row that opens the submenu. */
  childKey: string
  /** Whether a drag that leaves both panels closes the menu (More's). */
  escape: boolean
  onActive: (active: boolean) => void
  /** Whether a row can be chosen; a row that cannot is inert. */
  canChoose: (key: string) => boolean
  onChoose: (key: string) => void
}

export interface DropMenu {
  open: boolean
  /** How the menu was opened: a drag lists the rows nearest the finger first. */
  mode: 'tap' | 'drag'
  child: boolean
  hover: string | undefined
  /** The trigger was tapped. */
  toggle: () => void
  close: () => void
  /** A row was tapped. */
  select: (key: string) => void
  /** A press on the trigger, in window coordinates. */
  begin: (x: number, y: number) => void
  move: (x: number, y: number) => void
  end: (x: number, y: number) => void
  cancel: () => void
  setRow: (key: string, rect: DropRect | undefined) => void
  /** Where a row was last measured. */
  rowRect: (key: string) => DropRect | undefined
  setPanel: (panel: 'parent' | 'child', rect: DropRect | undefined) => void
}

export function useDropMenu(options: DropMenuOptions): DropMenu {
  const latest = useRef(options)
  latest.current = options
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<'tap' | 'drag'>('tap')
  const [child, setChild] = useState(false)
  const [hover, setHover] = useState<string>()
  const rows = useRef(new Map<string, DropRect>())
  const panels = useRef<{ parent?: DropRect; child?: DropRect }>({})
  const gesture = useRef<{
    startY: number
    dragged: boolean
    escaped: boolean
  } | null>(null)

  const close = useCallback((): void => {
    setOpen(false)
    setChild(false)
    setHover(undefined)
    latest.current.onActive(false)
  }, [])
  const show = useCallback((how: 'tap' | 'drag'): void => {
    if (latest.current.disabled) return
    setMode(how)
    setOpen(true)
    latest.current.onActive(true)
  }, [])
  const choose = useCallback(
    (key: string): void => {
      const { disabled, canChoose, onChoose } = latest.current
      if (disabled || !canChoose(key)) return
      close()
      onChoose(key)
    },
    [close]
  )

  const { disabled } = options
  useEffect(() => {
    if (!disabled) return
    gesture.current = null
    setOpen(false)
    setChild(false)
    setHover(undefined)
    latest.current.onActive(false)
  }, [disabled])

  return {
    open,
    mode,
    child,
    hover,
    toggle: () => {
      if (open) close()
      else show('tap')
    },
    close,
    select: key => {
      if (key === latest.current.childKey) {
        if (latest.current.canChoose(key)) setChild(value => !value)
      } else choose(key)
    },
    begin: (_x, y) => {
      if (latest.current.disabled) return
      gesture.current = { startY: y, dragged: false, escaped: false }
    },
    move: (x, y) => {
      const active = gesture.current
      if (active == null || active.escaped || latest.current.disabled) return
      if (!active.dragged) {
        if (active.startY - y <= DRAG_OPEN_PX) return
        active.dragged = true
        show('drag')
      }
      const key = dropRowAt(rows.current, x, y)
      const { parent, child: childPanel } = panels.current
      if (
        latest.current.escape &&
        key == null &&
        leftDropMenu({ x, y }, active.startY, parent, childPanel)
      ) {
        active.escaped = true
        close()
        return
      }
      const usable = key != null && latest.current.canChoose(key)
      setHover(usable ? key : undefined)
      if (key === latest.current.childKey) {
        if (usable) setChild(true)
      } else if (
        parent != null &&
        x >= parent.x &&
        x <= parent.x + parent.width &&
        !inDropRect(childPanel, x, y)
      )
        setChild(false)
    },
    end: (x, y) => {
      const active = gesture.current
      gesture.current = null
      if (active == null || !active.dragged || active.escaped) return
      const key = dropRowAt(rows.current, x, y)
      if (key != null && key !== latest.current.childKey) choose(key)
      else close()
    },
    cancel: () => {
      const active = gesture.current
      gesture.current = null
      if (active?.dragged === true && !active.escaped) close()
    },
    setRow: (key, rect) => {
      if (rect == null) rows.current.delete(key)
      else rows.current.set(key, rect)
    },
    rowRect: key => rows.current.get(key),
    setPanel: (panel, rect) => {
      panels.current[panel] = rect
    }
  }
}
