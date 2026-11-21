import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { AppState } from 'react-native'

import { type AgeBand, asAgeView } from '../../common/age'
import type { TeamStationClient } from '../../common/api'
import { isAgeSet } from '../../common/errors'
import { ME_AGE } from '../sync/documentKeys'
import { AgeSheet } from './AgeSheet'
import type { AppleAge } from './declaredAge'

/**
 * Whether a chat surface may be drawn for the person signed in, from their
 * age band (`GET /me/account/age`) and this device's Apple answer:
 *
 * - `allowed` — signed out (sign-in keeps its own handling), a band of 13 to
 *   17 or adult, or Apple says 18 or older (saved for the account at once);
 * - `blocked` — under 13, by the band or by this device's Apple answer;
 * - `pending` — Apple, or the server, has not answered yet;
 * - `ask` — no age on file: the age modal comes first.
 */
export type ChatAccess = 'allowed' | 'blocked' | 'pending' | 'ask'

/** What a screen does when its chat surface is declined, or agreed to. */
export interface ChatAgeRequest {
  onDecline: () => void
  onAgreed?: () => void
}

export interface HeldRequest extends ChatAgeRequest {
  id: number
  /** The scene that asked; its sheet is drawn only while that scene is on top. */
  frame: string
}

type ServerStatus = 'loading' | 'failed' | AgeBand

/** The person's first answer, as the age modal gives it. */
export type AgeAnswer = { year: number; month: number } | { adult: true }

export interface ChatAgeState {
  access: ChatAccess
  /**
   * Saves the person's first answer, with this device's Apple range; throws,
   * leaving `ask`, when it does not save.
   */
  answer: (body: AgeAnswer) => Promise<AgeBand>
  /** This device's Apple answer, which narrows what the modal offers. */
  apple: AppleAge
  /** The person signed in, or undefined when nobody is. */
  userId?: string
  /** Reads the account again after a failed read. */
  retry: () => void
  /** True once a read of this account has failed and not been retried. */
  failed: boolean
  /** A screen's request for the sheet, by scene; the return withdraws it. */
  ask: (frame: string, request: ChatAgeRequest) => () => void
  /** Each scene's latest request: the one for the scene on top is drawn. */
  requests: Readonly<Record<string, HeldRequest>>
  /** Clears a request once it has been answered. */
  settle: (id: number) => void
}

const noop = (): void => undefined

const allowedState: ChatAgeState = {
  access: 'allowed',
  answer: async () => 'adult',
  apple: 'none',
  retry: noop,
  failed: false,
  ask: () => noop,
  requests: {},
  settle: noop
}

/** The Shell's chat age state; `allowed` where there is no Shell (a test). */
export const ChatAgeContext = createContext<ChatAgeState>(allowedState)

/** The scene key of the frame a screen is drawn in, set by the Shell. */
export const ChatFrameKey = createContext('root')

/** The access, read where a chat surface is drawn. */
export function useChatAge(): ChatAgeState {
  return useContext(ChatAgeContext)
}

/** Asks for the sheet on behalf of the frame this screen is drawn in. */
export function useChatAgeAsk(): (request: ChatAgeRequest) => () => void {
  const { ask } = useContext(ChatAgeContext)
  const frame = useContext(ChatFrameKey)
  return useCallback(
    (request: ChatAgeRequest) => ask(frame, request),
    [ask, frame]
  )
}

/**
 * How a screen's section change goes into the address: `true` replaces the
 * step, `'undo'` takes back the step that chose the section being left.
 */
export type TabCorrection = boolean | 'undo'

/**
 * A screen's Chats tab: while it is chosen and chat is locked, it asks for
 * the sheet, and Not Now goes `back` to the tab chosen before Chats (or
 * `fallback` when the screen opened on Chats), taking back the step that
 * chose Chats. Leaving the tab, agreeing or unmounting withdraws the request.
 */
export function useChatsTabGate<T extends string>(
  tab: T,
  fallback: T,
  back: (to: T, correcting: 'undo') => void
): void {
  const { access } = useChatAge()
  const ask = useChatAgeAsk()
  const chosen = tab === 'chats'
  const before = useRef<T>(chosen ? fallback : tab)
  useEffect(() => {
    if (!chosen) before.current = tab
  }, [chosen, tab])
  const backRef = useRef(back)
  backRef.current = back
  useEffect(() => {
    if (!chosen || access === 'allowed') return
    return ask({
      onDecline: () => {
        backRef.current(before.current, 'undo')
      }
    })
  }, [chosen, access, ask])
}

/**
 * A known band stands over a later read that fails, or that was asked before
 * this device's own answer and so answers from before it (`stale`). Any other
 * read is the account's age now and is kept: a guardian or an administrator
 * moving it to another band, or an administrator clearing it.
 */
function keepKnown(
  current: { user: string; status: ServerStatus } | undefined,
  userId: string,
  next: { user: string; status: ServerStatus },
  stale = false
): { user: string; status: ServerStatus } {
  return current?.user === userId &&
    (next.status === 'failed' || (stale && next.status === 'unknown')) &&
    (current.status === 'minor' ||
      current.status === 'adult' ||
      current.status === 'under13')
    ? current
    : next
}

/** A band chat is open to, which the game socket must hear chat for. */
const readsChat = (status: ServerStatus | undefined): boolean =>
  status === 'minor' || status === 'adult'

/**
 * The screens' requests for the sheet, one per frame: `ask` records a frame's
 * latest (its return withdraws it), `settle` clears one once answered.
 */
export function useChatAgeRequests(): Pick<
  ChatAgeState,
  'ask' | 'settle' | 'requests'
> {
  const [requests, setRequests] = useState<Record<string, HeldRequest>>({})
  const nextId = useRef(0)
  const ask = useCallback(
    (frame: string, wanted: ChatAgeRequest): (() => void) => {
      const id = ++nextId.current
      setRequests(current => ({
        ...current,
        [frame]: { ...wanted, id, frame }
      }))
      return () => {
        setRequests(current => withoutRequest(current, id))
      }
    },
    []
  )
  const settle = useCallback((id: number): void => {
    setRequests(current => withoutRequest(current, id))
  }, [])
  return { ask, settle, requests }
}

/** The requests without the one numbered `id`, the same object when none is. */
function withoutRequest(
  requests: Record<string, HeldRequest>,
  id: number
): Record<string, HeldRequest> {
  const frame = Object.keys(requests).find(key => requests[key].id === id)
  if (frame == null) return requests
  const { [frame]: _gone, ...rest } = requests
  return rest
}

/**
 * One account's age band, read once per signed-in person, and the access it
 * gives with this device's Apple answer. Apple's 18 or older saves the
 * account's age (`apple`) with no modal. A chat call refused `ageRequired`
 * reads the band again (`client.onAgeRequired`). Once the band opens chat
 * after a band that did not (an answer here or elsewhere, or a guardian or
 * an administrator), `onAnswered` is told, so the game socket reconnects and
 * hears chat.
 */
export function useChatAgeState(
  client: TeamStationClient,
  userId: string | undefined,
  apple: AppleAge,
  onAnswered?: () => void
): ChatAgeState {
  const [server, setServer] = useState<{ user: string; status: ServerStatus }>()
  const [attempt, setAttempt] = useState(0)
  const { ask, settle, requests } = useChatAgeRequests()
  const appleSent = useRef(new Set<string>())
  const answered = useRef(onAnswered)
  answered.current = onAnswered
  // Reads are numbered as they are asked; `answeredRead` is the last asked
  // before this device's latest answer, so a read up to it is stale.
  const reads = useRef(0)
  const answeredRead = useRef(0)

  useEffect(() => {
    if (userId == null) return
    let live = true
    // A read again keeps the answer it is replacing, so a modal open over a
    // failed read stays still rather than closing for the read and opening
    // again when it fails.
    setServer(current =>
      current?.user === userId ? current : { user: userId, status: 'loading' }
    )
    // A phone opens chat at once on a kept band of 13 to 17 or adult while
    // the read waits: an unreachable server can take seconds to fail. A kept
    // unknown age waits for the read, which may find an answer made
    // elsewhere, rather than raise a modal the read would take down again.
    client
      .cached(ME_AGE, asAgeView)
      .then(kept => {
        if (!live || (kept?.band !== 'minor' && kept?.band !== 'adult')) return
        const band = kept.band
        // It stands over a read that failed first, as over one still out.
        setServer(current =>
          current?.user === userId &&
          current.status !== 'loading' &&
          current.status !== 'failed'
            ? current
            : { user: userId, status: band }
        )
      })
      .catch(() => undefined)
    const read = ++reads.current
    client
      .myAge()
      .then(age => {
        if (live)
          setServer(current =>
            keepKnown(
              current,
              userId,
              { user: userId, status: age.band },
              read <= answeredRead.current
            )
          )
      })
      .catch(() => {
        if (live)
          setServer(current =>
            keepKnown(current, userId, { user: userId, status: 'failed' })
          )
      })
    return () => {
      live = false
    }
  }, [client, userId, attempt])

  // A chat call refused for want of an age reads the band again.
  useEffect(() => {
    if (userId == null) return
    const refresh = (): void => {
      setAttempt(value => value + 1)
    }
    client.onAgeRequired = refresh
    return () => {
      if (client.onAgeRequired === refresh) client.onAgeRequired = undefined
    }
  }, [client, userId])

  const status: ServerStatus =
    userId != null && server?.user === userId ? server.status : 'loading'

  // The socket registered for chat by the band it had when it connected:
  // a move from a band that read nothing to one that reads chat reconnects
  // it, whatever moved it.
  const before = useRef<{ user?: string; status: ServerStatus }>({
    status: 'loading'
  })
  useEffect(() => {
    const was = before.current
    before.current = { user: userId, status }
    if (
      was.user === userId &&
      (was.status === 'unknown' ||
        was.status === 'under13' ||
        was.status === 'failed') &&
      readsChat(status)
    )
      answered.current?.()
  }, [status, userId])

  // An answer given on another device reaches this one when it comes back
  // to the foreground (on events only: no timer polls an unanswered account).
  useEffect(() => {
    if (userId == null || (status !== 'unknown' && status !== 'failed')) return
    const page = (
      globalThis as unknown as {
        document?: {
          visibilityState?: string
          addEventListener?: (type: string, run: () => void) => void
          removeEventListener?: (type: string, run: () => void) => void
        }
      }
    ).document
    const again = (): void => {
      if (page?.visibilityState !== 'hidden') setAttempt(value => value + 1)
    }
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') again()
    })
    page?.addEventListener?.('visibilitychange', again)
    return () => {
      subscription.remove()
      page?.removeEventListener?.('visibilitychange', again)
    }
  }, [status, userId])

  const appleRange =
    typeof apple === 'string' || apple.kind === 'under13' ? undefined : apple

  // Apple's 18 or older is the account's age, saved once, as it is in flight
  // or done; one that fails is sent again after the next read (coming back to
  // the foreground), and one that lands is read back for a phone to keep.
  // Chat waits for it (`pending`), with no modal: until it lands the server
  // refuses every chat call. One the server refuses because the account has
  // an age already reads that age.
  useEffect(() => {
    if (userId == null || appleRange?.kind !== 'adult' || status !== 'unknown')
      return
    if (appleSent.current.has(userId)) return
    appleSent.current.add(userId)
    client
      .setMyAge({ apple: { lowerBound: appleRange.lowerBound } })
      .then(age => {
        answeredRead.current = reads.current
        setServer(current =>
          current?.user === userId
            ? { user: userId, status: age.band }
            : current
        )
        setAttempt(value => value + 1)
      })
      .catch((error: unknown) => {
        if (isAgeSet(error)) {
          setAttempt(value => value + 1)
          return
        }
        appleSent.current.delete(userId)
      })
  }, [appleRange, attempt, client, status, userId])

  const appleUnder13 = typeof apple !== 'string' && apple.kind === 'under13'
  const access: ChatAccess =
    userId == null
      ? 'allowed'
      : appleUnder13 || status === 'under13'
        ? 'blocked'
        : apple === 'pending'
          ? 'pending'
          : status === 'minor' || status === 'adult'
            ? 'allowed'
            : appleRange?.kind === 'adult'
              ? 'pending'
              : status === 'loading'
                ? 'pending'
                : 'ask'

  const answer = useCallback(
    async (body: AgeAnswer): Promise<AgeBand> => {
      if (userId == null) return 'unknown'
      const range =
        appleRange == null
          ? {}
          : {
              apple:
                appleRange.kind === 'minor'
                  ? {
                      lowerBound: appleRange.lowerBound,
                      upperBound: appleRange.upperBound
                    }
                  : { lowerBound: appleRange.lowerBound }
            }
      // Answered elsewhere already (another device, or a birth month a
      // guardian gave): the account's age is the answer.
      const age = await client
        .setMyAge({ ...body, ...range })
        .catch(async (error: unknown) => {
          if (!isAgeSet(error)) throw error
          return await client.myAge()
        })
      answeredRead.current = reads.current
      setServer({ user: userId, status: age.band })
      // Read it back, so a phone keeps the band for when it is offline.
      setAttempt(value => value + 1)
      return age.band
    },
    [appleRange, client, userId]
  )
  const retry = useCallback((): void => {
    setAttempt(value => value + 1)
  }, [])

  return useMemo(
    () => ({
      access,
      answer,
      apple,
      userId,
      retry,
      failed: status === 'failed',
      ask,
      requests,
      settle
    }),
    [access, answer, apple, userId, retry, status, ask, requests, settle]
  )
}

/**
 * The one modal, drawn by the Shell beside the stack rather than in any
 * scene, so it leaves in the render its reason leaves: the Shell's own chat
 * surface on top, or a request from the scene now on top.
 */
export function ChatAgeHost(props: {
  state: ChatAgeState
  topKey: string
  /** A chat surface of the Shell's own is on top. */
  chatSurface: boolean
  onLeaveChat: () => void
}): React.ReactElement | null {
  const { state, topKey, chatSurface, onLeaveChat } = props
  const { access, requests } = state
  const showing = access === 'ask' || access === 'blocked'
  const held = requests[topKey] as HeldRequest | undefined
  const owner: ChatAgeRequest | undefined = !showing
    ? undefined
    : chatSurface
      ? { onDecline: onLeaveChat }
      : held
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const pressing = useRef(false)
  /** The answer in flight; a withdrawal makes it count for nothing here. */
  const attempt = useRef(0)
  /** The answer in flight opens nothing when it lands, and frees the modal. */
  const withdraw = (): void => {
    attempt.current += 1
    pressing.current = false
    setBusy(false)
  }
  const open = owner != null
  // Whom the modal is drawn for: the Shell's chat surface or a held request.
  const ownerKey = !open ? undefined : chatSurface ? '' : held?.id
  const { failed: readFailed, retry } = state
  useEffect(() => {
    // A modal closed while chat is still locked (Back, an address, the asking
    // screen going) or handed to another request withdraws the answer, as
    // closing it does. One closed because chat opened lets it finish.
    if (showing) withdraw()
    // Each opening starts with no error from an earlier one.
    setFailed(false)
    if (!open) return
    if (readFailed) retry()
    // A modal that opens after a failed read asks the server again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownerKey])
  if (owner == null) return null
  const finish = (): void => {
    if (!chatSurface && held != null) state.settle(held.id)
  }
  const send = (body: AgeAnswer): void => {
    if (pressing.current) return
    pressing.current = true
    const mine = ++attempt.current
    const current = (): boolean => attempt.current === mine
    setBusy(true)
    setFailed(false)
    state
      .answer(body)
      .then(band => {
        // An answer under 13 leaves the modal up, as the notice.
        if (!current() || (band !== 'minor' && band !== 'adult')) return
        finish()
        owner.onAgreed?.()
      })
      .catch(() => {
        if (current()) setFailed(true)
      })
      .finally(() => {
        if (!current()) return
        pressing.current = false
        setBusy(false)
      })
  }
  return (
    <AgeSheet
      mode={access === 'blocked' ? 'notice' : 'ask'}
      apple={state.apple}
      busy={busy}
      failed={failed}
      onAnswer={send}
      onDecline={() => {
        // Closing while the answer saves withdraws it: its answer then opens
        // nothing here (an answer that lands still opens chat).
        withdraw()
        finish()
        owner.onDecline()
      }}
    />
  )
}
