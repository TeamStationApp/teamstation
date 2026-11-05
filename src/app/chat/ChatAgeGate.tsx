import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import {
  AppState,
  Modal,
  Pressable,
  ScrollView,
  Text,
  View
} from 'react-native'

import type { TeamStationClient } from '../../common/api'
import { asChatAge } from '../../common/chatAge'
import { Button } from '../components/Button'
import { CancelAction } from '../components/CancelAction'
import { lstrings } from '../locales/strings'
import { useInsets } from '../platform/safeArea'
import { ME_CHAT_AGE } from '../sync/documentKeys'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import type { AppleAge } from './declaredAge'

/**
 * Whether a chat surface may be drawn for the person signed in:
 *
 * - `allowed` — signed out (sign-in keeps its own handling), or confirmed,
 *   or this device's Apple answer is 13 or older;
 * - `blocked` — this device's Apple answer is under 13, whatever the account;
 * - `pending` — Apple, or the server, has not answered yet;
 * - `ask` — anything else: the consent sheet comes first.
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

type ServerStatus = 'loading' | 'confirmed' | 'unconfirmed' | 'failed'

export interface ChatAgeState {
  access: ChatAccess
  /** Agrees to the consent sheet; throws, leaving `ask`, when it does not save. */
  confirm: () => Promise<void>
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
  confirm: async () => undefined,
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
 * A confirmation is never taken back (the server keeps the first one for
 * good), so a later read — one that fails, or an older answer arriving after
 * an agreement — never turns a known confirmation for this person into
 * anything else.
 */
function keepConfirmed(
  current: { user: string; status: ServerStatus } | undefined,
  userId: string,
  next: { user: string; status: ServerStatus }
): { user: string; status: ServerStatus } {
  return current?.user === userId && current.status === 'confirmed'
    ? current
    : next
}

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
 * One account's chat age, read once per signed-in person, and the access it
 * gives with this device's Apple answer. An Apple answer of 13 or more
 * confirms an unconfirmed account (`apple`) with no sheet.
 */
export function useChatAgeState(
  client: TeamStationClient,
  userId: string | undefined,
  apple: AppleAge
): ChatAgeState {
  const [server, setServer] = useState<{ user: string; status: ServerStatus }>()
  const [attempt, setAttempt] = useState(0)
  const { ask, settle, requests } = useChatAgeRequests()
  const appleSent = useRef(new Set<string>())

  useEffect(() => {
    if (userId == null) return
    let live = true
    // A read again keeps the answer it is replacing, so a sheet open over a
    // failed read stays still rather than closing for the read and opening
    // again when it fails.
    setServer(current =>
      current?.user === userId ? current : { user: userId, status: 'loading' }
    )
    // A phone opens chat at once on a kept confirmation while the read waits:
    // an unreachable server can take seconds to fail. A confirmation is never
    // taken back, so the kept one also stands over a read that failed first
    // (a server error, a captive portal) or answered from an older state. A
    // kept unconfirmed answer waits for the read, which may find a
    // confirmation made elsewhere, rather than raise a sheet the read would
    // take down again.
    client
      .cached(ME_CHAT_AGE, asChatAge)
      .then(kept => {
        if (!live || kept?.confirmed !== true) return
        setServer({ user: userId, status: 'confirmed' })
      })
      .catch(() => undefined)
    client
      .chatAge()
      .then(answer => {
        if (live)
          setServer(current =>
            keepConfirmed(current, userId, {
              user: userId,
              status: answer.confirmed ? 'confirmed' : 'unconfirmed'
            })
          )
      })
      .catch(() => {
        if (live)
          setServer(current =>
            keepConfirmed(current, userId, { user: userId, status: 'failed' })
          )
      })
    return () => {
      live = false
    }
  }, [client, userId, attempt])

  const status: ServerStatus =
    userId != null && server?.user === userId ? server.status : 'loading'

  // A confirmation made on another device reaches this one when it comes back
  // to the foreground (on events only: no timer polls an unconfirmed account).
  useEffect(() => {
    if (userId == null || status === 'confirmed' || status === 'loading') return
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

  // Apple's 13 or older confirms the account once, as it is in flight or
  // done; one that fails is sent again after the next read (coming back to
  // the foreground), and one that lands is read back for a phone to keep.
  useEffect(() => {
    if (userId == null || apple !== 'over13' || status !== 'unconfirmed') return
    if (appleSent.current.has(userId)) return
    appleSent.current.add(userId)
    client
      .confirmChatAge('apple')
      .then(answer => {
        if (!answer.confirmed) throw new Error('Not confirmed')
        setServer(current =>
          current?.user === userId
            ? { user: userId, status: 'confirmed' }
            : current
        )
        setAttempt(value => value + 1)
      })
      .catch(() => {
        appleSent.current.delete(userId)
      })
  }, [apple, attempt, client, status, userId])

  const access: ChatAccess =
    userId == null
      ? 'allowed'
      : apple === 'under13'
        ? 'blocked'
        : apple === 'pending'
          ? 'pending'
          : status === 'confirmed' || apple === 'over13'
            ? 'allowed'
            : status === 'loading'
              ? 'pending'
              : 'ask'

  const confirm = useCallback(async (): Promise<void> => {
    if (userId == null) return
    const answer = await client.confirmChatAge('self')
    if (!answer.confirmed) throw new Error('Not confirmed')
    setServer({ user: userId, status: 'confirmed' })
    // Read it back, so a phone keeps the confirmation for when it is offline.
    setAttempt(value => value + 1)
  }, [client, userId])
  const retry = useCallback((): void => {
    setAttempt(value => value + 1)
  }, [])

  return useMemo(
    () => ({
      access,
      confirm,
      retry,
      failed: status === 'failed',
      ask,
      requests,
      settle
    }),
    [access, confirm, retry, status, ask, requests, settle]
  )
}

/**
 * The one sheet, drawn by the Shell beside the stack rather than in any
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
  /** The agreement in flight; a withdrawal makes its answer count for nothing. */
  const attempt = useRef(0)
  /** The agreement in flight opens nothing when it lands, and frees the sheet. */
  const withdraw = (): void => {
    attempt.current += 1
    pressing.current = false
    setBusy(false)
  }
  const open = owner != null
  // Whom the sheet is drawn for: the Shell's chat surface or a held request.
  const ownerKey = !open ? undefined : chatSurface ? '' : held?.id
  const { failed: readFailed, retry } = state
  useEffect(() => {
    // A sheet closed while chat is still locked (Back, an address, the asking
    // screen going) or handed to another request withdraws the agreement, as
    // Not Now does. One closed because chat opened lets it finish.
    if (showing) withdraw()
    // Each opening starts with no error from an earlier one.
    setFailed(false)
    if (!open) return
    if (readFailed) retry()
    // A sheet that opens after a failed read asks the server again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownerKey])
  if (owner == null) return null
  const finish = (): void => {
    if (!chatSurface && held != null) state.settle(held.id)
  }
  return (
    <ChatAgeSheet
      mode={access === 'blocked' ? 'notice' : 'consent'}
      busy={busy}
      failed={failed}
      onAgree={() => {
        if (pressing.current) return
        pressing.current = true
        const mine = ++attempt.current
        const current = (): boolean => attempt.current === mine
        setBusy(true)
        setFailed(false)
        state
          .confirm()
          .then(() => {
            if (!current()) return
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
      }}
      onDecline={() => {
        // A decline while the agreement saves withdraws it: its answer then
        // opens nothing (a confirmation that lands still unlocks chat).
        withdraw()
        finish()
        owner.onDecline()
      }}
    />
  )
}

/** The consent sheet, or the under-13 notice. */
export function ChatAgeSheet(props: {
  mode: 'consent' | 'notice'
  busy?: boolean
  failed?: boolean
  onAgree: () => void
  onDecline: () => void
}): React.ReactElement {
  const { mode, busy = false, failed = false, onAgree, onDecline } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  const insets = useInsets()
  const notice = mode === 'notice'
  return (
    <Modal transparent animationType="slide" visible onRequestClose={onDecline}>
      <View style={styles.scrim}>
        <Pressable
          accessibilityLabel={
            notice ? lstrings.chat_age_under13_ok : lstrings.chat_age_decline
          }
          style={styles.behind}
          onPress={onDecline}
        />
        <View
          style={[
            styles.sheet,
            { paddingBottom: Math.max(insets.bottom, theme.rem(1.5)) }
          ]}
          testID="chat-age-sheet"
          accessibilityViewIsModal
        >
          <Text style={styles.title} accessibilityRole="header">
            {notice ? lstrings.chat_age_under13_title : lstrings.chat_age_title}
          </Text>
          {/* At large text sizes the words scroll; the buttons stay in reach. */}
          <ScrollView style={styles.content}>
            {notice ? (
              <Text style={styles.body}>{lstrings.chat_age_under13_body}</Text>
            ) : (
              <>
                <Text style={styles.body}>{lstrings.chat_age_body}</Text>
                <Text style={[styles.body, styles.paragraph]}>
                  {lstrings.chat_age_rules}
                </Text>
              </>
            )}
            {failed && (
              <Text
                style={[styles.failed, styles.paragraph]}
                accessibilityRole="alert"
              >
                {lstrings.chat_age_failed}
              </Text>
            )}
          </ScrollView>
          {notice ? (
            <Button
              label={lstrings.chat_age_under13_ok}
              block
              testID="chat-age-ok"
              onPress={onDecline}
            />
          ) : (
            <>
              <Button
                label={lstrings.chat_age_agree}
                block
                busy={busy}
                disabled={busy}
                testID="chat-age-agree"
                onPress={onAgree}
              />
              {/* Never disabled: Not Now withdraws an agreement still saving. */}
              <CancelAction
                label={lstrings.chat_age_decline}
                testID="chat-age-decline"
                onPress={onDecline}
              />
            </>
          )}
        </View>
      </View>
    </Modal>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  scrim: { flex: 1, justifyContent: 'flex-end' },
  behind: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: theme.overlayBackgroundColor
  },
  sheet: {
    width: '100%',
    maxWidth: theme.rem(36),
    alignSelf: 'center',
    backgroundColor: theme.cardBackgroundColor,
    borderTopLeftRadius: theme.rem(theme.radiusLargeRem),
    borderTopRightRadius: theme.rem(theme.radiusLargeRem),
    borderWidth: 1,
    borderColor: theme.defaultBorderColor,
    maxHeight: '85%',
    padding: theme.rem(theme.spaceLgRem),
    gap: theme.rem(theme.spaceMdRem)
  },
  content: { flexGrow: 0 },
  paragraph: { marginTop: theme.rem(theme.spaceMdRem) },
  title: {
    fontFamily: theme.boldTextFont,
    fontSize: theme.rem(1.125),
    fontWeight: '700',
    color: theme.primaryTextColor
  },
  body: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.9375),
    lineHeight: theme.rem(1.375),
    color: theme.primaryTextColor
  },
  failed: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.875),
    color: theme.dangerColor
  }
}))
