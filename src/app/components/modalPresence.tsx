import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore
} from 'react'

/**
 * The app's modals on show, as one signal: every `Modal` of the app's
 * (`components/Modal`) is counted while it is on show, and until its
 * dismissal has finished, so something that must never stack on another
 * modal (the ask about notifications) waits for the count to reach none,
 * whichever screen drew them. One modal may claim the screen instead
 * (`claims`): while it is up, and until it has finished going, every other
 * modal waits, and shows after.
 *
 * The count is kept outside React's state, in a store that only what reads
 * it subscribes to: a modal coming or going re-renders that modal's screen
 * and the ask's host, never the shell around them.
 */
export interface ModalPresence {
  /** A modal on show; the return lets go of it, once however often called. */
  show: () => () => void
  /** A modal that claims the screen on show; the return lets go of it. */
  claim: () => () => void
  /** How many modals are on show, leaving out one that claims the screen. */
  open: () => number
  /** Whether a modal on show claims the screen. */
  claimed: () => boolean
  subscribe: (listener: () => void) => () => void
  /**
   * How long a modal that has gone is still counted where nothing reports
   * the end of its dismissal: Android, and a modal unmounted while up.
   */
  dismissMs: number
}

/**
 * Longer than a native modal's dismissal takes to finish: iOS's slide
 * down, Android's and the browser's fade or slide out.
 */
export const DISMISS_MS = 750

/** The shell's count of modals, for `ModalPresenceProvider`. */
export function createModalPresence(dismissMs = DISMISS_MS): ModalPresence {
  let open = 0
  let claims = 0
  const listeners = new Set<() => void>()
  const changed = (): void => {
    for (const listener of [...listeners]) listener()
  }
  const hold = (add: (by: number) => void): (() => void) => {
    add(1)
    changed()
    let held = true
    return () => {
      if (!held) return
      held = false
      add(-1)
      changed()
    }
  }
  return {
    show: () =>
      hold(by => {
        open += by
      }),
    claim: () =>
      hold(by => {
        claims += by
      }),
    open: () => open,
    claimed: () => claims > 0,
    subscribe: listener => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    dismissMs
  }
}

const noop = (): void => undefined

/** Outside the app's shell (a screen drawn alone): nothing is counted. */
const nowhere: ModalPresence = {
  show: () => noop,
  claim: () => noop,
  open: () => 0,
  claimed: () => false,
  subscribe: () => noop,
  dismissMs: 0
}

const PresenceContext = createContext<ModalPresence>(nowhere)

/**
 * Gives the shell's modals their count: `presence`, or one of its own. The
 * value never changes, so nothing under it re-renders for a modal; only
 * what subscribes to the count does.
 */
export function ModalPresenceProvider(props: {
  presence?: ModalPresence
  children: React.ReactNode
}): React.ReactElement {
  const [own] = useState(() => props.presence ?? createModalPresence())
  return (
    <PresenceContext.Provider value={own}>
      {props.children}
    </PresenceContext.Provider>
  )
}

/** The shell's count itself, for a reading that must be the latest. */
export function useModalPresence(): ModalPresence {
  return useContext(PresenceContext)
}

/**
 * While `active`, counted as a modal on show: for a surface that is not a
 * `Modal` but must not be covered either (chat's gates while this device is
 * set up for chat).
 */
export function useShowsModal(active: boolean): void {
  const { show } = useContext(PresenceContext)
  useEffect(() => (active ? show() : undefined), [active, show])
}

/** Whether a modal on show claims the screen. */
export function useScreenClaimed(): boolean {
  const presence = useContext(PresenceContext)
  return useSyncExternalStore(presence.subscribe, presence.claimed)
}

/** How many modals are on show, leaving out one that claims the screen. */
export function useModalsOpen(): number {
  const presence = useContext(PresenceContext)
  return useSyncExternalStore(presence.subscribe, presence.open)
}
