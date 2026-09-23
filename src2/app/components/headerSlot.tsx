import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'

/**
 * What the header is holding for whichever screen is on top.
 *
 * The header belongs to the shell and the thing that scrolls out of view
 * belongs to a screen, so one of them has to hand it to the other. The screen
 * builds its own copy — the same component, in a compact form — and puts it
 * here; the shell draws whatever is here and nothing else.
 *
 * `headerHeight` travels the same way, because two things need it and neither
 * should carry a second copy of the number: the content's top padding, so a
 * list starts below the glass rather than under it, and the handoff itself,
 * which is measured from the moment something passes beneath.
 */
export interface HeaderSlot {
  headerHeight: number
  setHandoff: (node: React.ReactNode) => void
  /** A screen that wants the header's back, instead of leaving the screen. */
  setBackOverride: (handler: (() => void) | null) => void
}

const HeaderSlotContext = createContext<HeaderSlot>({
  headerHeight: 48,
  setHandoff: () => undefined,
  setBackOverride: () => undefined
})

export function useHeaderSlot(): HeaderSlot {
  return useContext(HeaderSlotContext)
}

export interface HeaderSlotProviderProps {
  headerHeight: number
  onHandoff: (node: React.ReactNode) => void
  onBackOverride?: (handler: (() => void) | null) => void
  children: React.ReactNode
}

export function HeaderSlotProvider(
  props: HeaderSlotProviderProps
): React.ReactElement {
  const { headerHeight, onHandoff, onBackOverride, children } = props
  const value = useMemo(
    () => ({
      headerHeight,
      setHandoff: onHandoff,
      setBackOverride: onBackOverride ?? (() => undefined)
    }),
    [headerHeight, onHandoff, onBackOverride]
  )
  return (
    <HeaderSlotContext.Provider value={value}>
      {children}
    </HeaderSlotContext.Provider>
  )
}

/**
 * Put something in the header for as long as this screen is on top.
 *
 * Clearing it on the way out is the whole reason this is a hook: a screen that
 * left its score in the header would leave it there over the next screen.
 */
/**
 * Take the header's back while `active`. Letting go returns the chevron to
 * leaving the screen.
 *
 * The handler is read through a ref, so a new function each render does not
 * re-subscribe the header.
 */
export function useBackOverride(active: boolean, handler: () => void): void {
  const { setBackOverride } = useHeaderSlot()
  const handlerRef = useRef(handler)
  handlerRef.current = handler
  useEffect(() => {
    if (!active) return
    setBackOverride(() => {
      handlerRef.current()
    })
    return () => {
      setBackOverride(null)
    }
  }, [active, setBackOverride])
}

export function useHeaderHandoff(node: React.ReactNode): void {
  const { setHandoff } = useHeaderSlot()
  useEffect(() => {
    setHandoff(node)
    return () => {
      setHandoff(null)
    }
  }, [node, setHandoff])
}

/** The shell's side of it: what to draw, and a stable setter to hand down. */
export function useHandoffSlot(): {
  handoff: React.ReactNode
  setHandoff: (node: React.ReactNode) => void
} {
  const [handoff, setHandoffState] = useState<React.ReactNode>(null)
  const setHandoff = useCallback((node: React.ReactNode) => {
    setHandoffState(node)
  }, [])
  return { handoff, setHandoff }
}
