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
  navigationHeight?: number
  setHandoff: (node: React.ReactNode) => void
  setHandoffHeight: (height: number) => void
  /** A screen that wants the header's back, instead of leaving the screen. */
  setBackOverride: (handler: (() => void) | null) => void
}

const HeaderSlotContext = createContext<HeaderSlot>({
  headerHeight: 48,
  setHandoff: () => undefined,
  setHandoffHeight: () => undefined,
  setBackOverride: () => undefined
})

export function useHeaderSlot(): HeaderSlot {
  return useContext(HeaderSlotContext)
}

export interface HeaderSlotProviderProps {
  headerHeight: number
  navigationHeight?: number
  onHandoff: (node: React.ReactNode) => void
  onHandoffHeight?: (height: number) => void
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
      navigationHeight: props.navigationHeight,
      setHandoff: onHandoff,
      setHandoffHeight: props.onHandoffHeight ?? (() => undefined),
      setBackOverride: onBackOverride ?? (() => undefined)
    }),
    [
      headerHeight,
      props.navigationHeight,
      onHandoff,
      props.onHandoffHeight,
      onBackOverride
    ]
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
 * Who holds each slot's back, latest last. Two holders can overlap in one
 * screen — a message's menu still closing as the mention picker opens over
 * it — and the one letting go hands Back to the one before it, not to
 * nobody.
 */
const backHolders = new WeakMap<
  (handler: (() => void) | null) => void,
  Array<() => void>
>()

/**
 * Take the header's back while `active`. Letting go returns it to whoever
 * held it before, or the chevron to leaving the screen.
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
    const held = (): void => {
      handlerRef.current()
    }
    const holders = backHolders.get(setBackOverride) ?? []
    backHolders.set(setBackOverride, [...holders, held])
    setBackOverride(held)
    return () => {
      const rest = (backHolders.get(setBackOverride) ?? []).filter(
        holder => holder !== held
      )
      backHolders.set(setBackOverride, rest)
      setBackOverride(rest.at(-1) ?? null)
    }
  }, [active, setBackOverride])
}

export function useHeaderHandoff(
  node: React.ReactNode,
  contentHeight = 0
): void {
  const { setHandoff, setHandoffHeight } = useHeaderSlot()
  useEffect(() => {
    setHandoff(node)
    setHandoffHeight(contentHeight)
    return () => {
      setHandoff(null)
      setHandoffHeight(0)
    }
  }, [node, contentHeight, setHandoff, setHandoffHeight])
}

/** The shell's side of it: what to draw, and a stable setter to hand down. */
export function useHandoffSlot(): {
  handoff: React.ReactNode
  handoffHeight: number
  setHandoffHeight: (height: number) => void
  setHandoff: (node: React.ReactNode) => void
} {
  const [handoff, setHandoffState] = useState<React.ReactNode>(null)
  const [handoffHeight, setHandoffHeight] = useState(0)
  const setHandoff = useCallback((node: React.ReactNode) => {
    setHandoffState(node)
  }, [])
  return { handoff, setHandoff, handoffHeight, setHandoffHeight }
}
