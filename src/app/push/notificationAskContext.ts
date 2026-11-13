import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState
} from 'react'

import type { AskReason } from './notificationAsk'

/**
 * What a screen does with the app's ask about notifications: a request
 * waits for its moment (`NotificationAskHost`), which no modal on show
 * (`modalPresence`) holds back. Both are stable, so a screen holding them
 * never re-renders for a request.
 */
export interface NotificationAskActions {
  /** Asks, for `reason`, once the moment allows; once per person per device. */
  request: (reason: AskReason) => void
  /** Withdraws a request for `reason` not yet started. */
  withdraw: (reason: AskReason) => void
}

/** The shell's requests, which only `NotificationAskHost` reads. */
export interface NotificationAskState {
  /** What `NotificationAskContext` gives every screen. */
  actions: NotificationAskActions
  /** The reasons waiting. */
  pending: ReadonlySet<AskReason>
  /** Clears every waiting request, once the ask has started. */
  settle: () => void
}

const noop = (): void => undefined
const none: ReadonlySet<AskReason> = new Set()

/** Outside the app's shell (a screen drawn alone): nothing asks. */
export const NotificationAskContext = createContext<NotificationAskActions>({
  request: noop,
  withdraw: noop
})

/** The shell's requests; its `actions` are for `NotificationAskContext`. */
export function useNotificationAskState(): NotificationAskState {
  const [pending, setPending] = useState<ReadonlySet<AskReason>>(none)
  const request = useCallback((reason: AskReason): void => {
    setPending(current =>
      current.has(reason) ? current : new Set([...current, reason])
    )
  }, [])
  const withdraw = useCallback((reason: AskReason): void => {
    setPending(current => {
      if (!current.has(reason)) return current
      const next = new Set(current)
      next.delete(reason)
      return next
    })
  }, [])
  const settle = useCallback((): void => {
    setPending(none)
  }, [])
  const actions = useMemo(() => ({ request, withdraw }), [request, withdraw])
  return useMemo(
    () => ({ actions, pending, settle }),
    [actions, pending, settle]
  )
}

/**
 * Asks about notifications, for `reason`: after an RSVP answer, or on
 * entering messaging from inside the app (never from a notification's tap or
 * a link). Every surface calls this one.
 */
export function useNotificationAsk(): (reason: AskReason) => void {
  return useContext(NotificationAskContext).request
}
