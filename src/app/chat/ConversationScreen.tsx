import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  Keyboard,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Platform,
  Pressable,
  ScrollView,
  Text,
  useWindowDimensions,
  View
} from 'react-native'

import { MAX_ATTACHMENTS } from '../../common/chatContent'
import {
  Button,
  FLOATING_BOTTOM_REM,
  Icon,
  NAV_CLEARANCE_REM,
  Screen
} from '../components'
import { navClearanceAboveInset } from '../components/navClearance'
import { lstrings, plural, sprintf } from '../locales/strings'
import { useInsets } from '../platform/safeArea'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import type { ChatFileOps } from './AttachmentView'
import { copyChatText } from './chatClipboard'
import { attachmentProblem, sendAllowed } from './chatComposeModel'
import { ChatDropTarget } from './ChatDropTarget'
import * as platformFiles from './chatFiles'
import type { PickedFile, PickSource } from './chatFileTypes'
import {
  actionsFor,
  approvalsIn,
  conversationPill,
  conversationTitle,
  type MessageAction,
  typingNames
} from './chatModel'
import { getChatStyles } from './chatStyles'
import {
  bindUserScroll,
  isFinePointer,
  isRestoringPopupFocus,
  readDocumentActive,
  watchReadDocumentActive
} from './chatWebInteractions'
import {
  type ChatDraft,
  ChatDraftOwner,
  emptyChatDraft,
  newChatWorkspaceState
} from './chatWorkspaceModel'
import { Composer } from './Composer'
import { ConversationMenu } from './ConversationMenu'
import { EmojiPicker } from './EmojiPicker'
import type { MessageView } from './engine/apply'
import type { ConversationView, GrantApproval } from './engine/engine'
import { findOriginal, replyExcerpt } from './engine/reply'
import { MessageBubble } from './MessageBubble'
import { MessageMenu } from './MessageMenu'
import { PinnedMessages } from './PinnedMessages'
import type { ChatScreenEngine } from './screenEngine'

/** What the screen needs of the platform's file twin. */
export interface ConversationFiles extends ChatFileOps {
  PICK_SOURCES: PickSource[]
  pickFiles: (source: PickSource, remaining?: number) => Promise<PickedFile[]>
}

export interface ConversationScreenProps {
  engine: ChatScreenEngine
  conversationId: string
  /** The signed-in person, who is never asked to approve their own reset. */
  userId: number
  /** The members and safety numbers, from the header's Members button. */
  onMembers: () => void
  /** The chat's title once it is known, for the header. */
  onTitle?: (title: string) => void
  /** The platform's attachments; `chatFiles` by default. */
  files?: ConversationFiles
  /** Swipe a message right to reply; on phones by default. */
  swipe?: boolean
  embedded?: boolean
  active?: boolean
  readingSession?: number
  draft?: ChatDraft
  draftOwner?: ChatDraftOwner
  onDraftChange?: (draft: ChatDraft) => void
}

/**
 * How tall the phone's keyboard stands, 0 when it is down (and always in a
 * browser, which has none of its own).
 */
export function useKeyboardHeight(): number {
  const [height, setHeight] = useState(0)
  useEffect(() => {
    const shown = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow',
      event => {
        setHeight(event.endCoordinates.height)
      }
    )
    const hidden = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide',
      () => {
        setHeight(0)
      }
    )
    return () => {
      shown.remove()
      hidden.remove()
    }
  }, [])
  return height
}

/** How often a chat not open yet is tried again, and how many times. */
export const OPEN_RETRY_MS = 2000
export const OPEN_TRIES = 8

/** A notice in the stream: a safety number change, or where history ends. */
type Notice =
  | { kind: 'lost'; key: string }
  | { kind: 'safety'; key: string; name: string | undefined }

/**
 * One chat. Messages in bubbles with who sent them and, on the person's
 * own, who has read them; a typing line; banners for locked history, a
 * chain break and an unverified membership record; a long-press menu
 * (reply, react, edit, delete, and Delete for everyone for moderators);
 * swipe-to-reply on phones; and the composer, which shows only where the
 * person may post and is held off while history is locked.
 */
export function ConversationScreen(
  props: ConversationScreenProps
): React.ReactElement {
  const { engine, conversationId, userId, onMembers, onTitle } = props
  const files = props.files ?? platformFiles
  const swipe = props.swipe ?? Platform.OS !== 'web'
  const theme = useTheme()
  const styles = getStyles(theme)
  const shared = getChatStyles(theme)
  const window = useWindowDimensions()
  const bubbleWidth = Math.min(window.width * 0.7, theme.rem(22))
  const insets = useInsets()
  const keyboard = useKeyboardHeight()
  // The keyboard rises over the capsule's clearance under the column; the
  // composer is lifted by what is left of it, so it stays above the keys.
  const clearance =
    navClearanceAboveInset(
      Platform.OS,
      theme.rem(NAV_CLEARANCE_REM),
      theme.rem(FLOATING_BOTTOM_REM)
    ) + insets.bottom
  const lift = Math.max(0, keyboard - clearance)

  const { onDraftChange } = props
  const [localDraftOwner] = useState(() => {
    const state = newChatWorkspaceState()
    state.drafts.set(conversationId, props.draft ?? emptyChatDraft())
    return new ChatDraftOwner(state)
  })
  const draftOwner = props.draftOwner ?? localDraftOwner
  const [view, setView] = useState<ConversationView | undefined>(undefined)
  const latestView = useRef<ConversationView | undefined>(undefined)
  latestView.current = view
  const [failed, setFailed] = useState(false)
  const [text, setText] = useState(props.draft?.text ?? '')
  const textNow = useRef(text)
  textNow.current = text
  const [replyTo, setReplyTo] = useState<MessageView | undefined>(
    props.draft?.replyTo
  )
  const replyNow = useRef(replyTo)
  replyNow.current = replyTo
  const [editing, setEditing] = useState<MessageView | undefined>(
    props.draft?.editing
  )
  const editingNow = useRef(editing)
  editingNow.current = editing
  const [picked, setPicked] = useState<PickedFile[]>(props.draft?.picked ?? [])
  const [sending, setSending] = useState(() =>
    draftOwner.isSending(conversationId)
  )
  const sendingNow = useRef(sending)
  const preparingNow = useRef(0)
  const [preparing, setPreparing] = useState(0)
  const preparationGeneration = useRef(0)
  const preparationQueue = useRef<Promise<unknown>>(Promise.resolve())
  const pickedNow = useRef(picked)
  pickedNow.current = picked
  useEffect(() => {
    preparationGeneration.current += 1
    preparingNow.current = 0
    setPreparing(0)
    preparationQueue.current = Promise.resolve()
    return () => {
      preparationGeneration.current += 1
    }
  }, [conversationId, props.active])
  const [error, setError] = useState<string | undefined>(() =>
    draftOwner.failed(conversationId) ? lstrings.chat_send_failed : undefined
  )
  const [reported, setReported] = useState(false)
  const [menu, setMenu] = useState<MessageView | undefined>(undefined)
  const [menuAnchor, setMenuAnchor] = useState<unknown>(undefined)
  const [pinsOpen, setPinsOpen] = useState(false)
  const [highlight, setHighlight] = useState<string | undefined>(undefined)
  const jumpGeneration = useRef(0)
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined
  )
  const gestureGeneration = useRef(0)
  const messagePositions = useRef(new Map<string, number>())
  const messageRefs = useRef(new Map<string, React.ComponentRef<typeof View>>())
  const measuringJump = useRef<number | undefined>(undefined)
  const prepend = useRef<
    | {
        offset: number
        content: number
        firstSeq: number | undefined
        positions: Map<string, number>
        anchor: { id: string; relativeY: number } | undefined
      }
    | undefined
  >(undefined)
  const [reacting, setReacting] = useState<MessageView | undefined>(undefined)
  const [conversationMenu, setConversationMenu] = useState(false)
  const readRevision = useRef<number | undefined>(undefined)
  const paneActive = useRef(props.active !== false)
  paneActive.current = props.active !== false
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const [documentActive, setDocumentActive] = useState(readDocumentActive)
  useEffect(() => watchReadDocumentActive(setDocumentActive), [])
  const [approvals, setApprovals] = useState<GrantApproval[]>([])
  const scroller = useRef<React.ComponentRef<typeof ScrollView>>(null)
  // Where the list is, to keep it on the newest message while the person
  // is there: a list read at its bottom follows what arrives, one scrolled
  // up to older messages stays put.
  const scrolled = useRef({
    offset: props.draft?.scrollOffset ?? 0,
    hasPosition:
      props.draft?.hasScrollPosition === true ||
      (props.draft?.scrollOffset ?? 0) > 0,
    followNewest: props.draft?.followNewest === true,
    anchor: props.draft?.scrollAnchor,
    height: 0,
    content: 0
  })
  useEffect(
    () =>
      draftOwner.attach(
        conversationId,
        () => ({
          text: textNow.current,
          replyTo: replyNow.current,
          editing: editingNow.current,
          picked: pickedNow.current,
          scrollOffset: scrolled.current.offset,
          hasScrollPosition: scrolled.current.hasPosition,
          followNewest: scrolled.current.followNewest,
          scrollAnchor: scrolled.current.anchor
        }),
        () => {
          if (!mounted.current) return
          const next = draftOwner.draft(conversationId)
          textNow.current = next.text
          replyNow.current = next.replyTo
          editingNow.current = next.editing
          pickedNow.current = next.picked
          setText(next.text)
          setReplyTo(next.replyTo)
          setEditing(next.editing)
          setPicked(next.picked)
          sendingNow.current = draftOwner.isSending(conversationId)
          setSending(sendingNow.current)
          setError(
            draftOwner.failed(conversationId)
              ? lstrings.chat_send_failed
              : undefined
          )
        }
      ),
    [draftOwner, conversationId]
  )
  const restoreTarget = useRef<number | undefined>(
    scrolled.current.hasPosition && !scrolled.current.followNewest
      ? scrolled.current.offset
      : undefined
  )
  const restoreAnchor = useRef(
    scrolled.current.hasPosition && !scrolled.current.followNewest
      ? scrolled.current.anchor
      : undefined
  )
  const restoringAnchor = useRef(false)
  const restoreAnchorDirty = useRef(false)
  const atBottom = useRef(
    !scrolled.current.hasPosition || scrolled.current.followNewest
  )
  const readingAnchor = useCallback(
    (
      positions: Map<string, number>
    ): { id: string; relativeY: number } | undefined => {
      const offset = scrolled.current.offset
      const ordered = [...positions].sort((a, b) => a[1] - b[1])
      const visible = ordered.find(
        ([, y]) => y >= offset && y < offset + scrolled.current.height
      )
      const chosen = visible ?? ordered.filter(([, y]) => y <= offset).at(-1)
      return chosen == null
        ? undefined
        : { id: chosen[0], relativeY: chosen[1] - offset }
    },
    []
  )
  const prepareFiles = (
    work: (remaining: number) => Promise<PickedFile[]>
  ): void => {
    const current = latestView.current
    if (
      current?.composer !== 'enabled' ||
      editing != null ||
      sendingNow.current ||
      props.active === false
    ) {
      setError(lstrings.chat_attachment_blocked)
      return
    }
    const generation = preparationGeneration.current
    preparingNow.current += 1
    setPreparing(preparingNow.current)
    setError(undefined)
    preparationQueue.current = preparationQueue.current
      .catch(() => undefined)
      .then(async () => {
        if (generation !== preparationGeneration.current) return
        const chosen = await work(MAX_ATTACHMENTS - pickedNow.current.length)
        if (
          generation !== preparationGeneration.current ||
          latestView.current?.composer !== 'enabled'
        )
          return
        const problem = attachmentProblem(
          chosen.map(file => ({
            fileName: file.fileName,
            size: file.bytes.length
          })),
          MAX_ATTACHMENTS - pickedNow.current.length
        )
        if (problem != null) throw new Error(problem)
        const next = [...pickedNow.current, ...chosen]
        pickedNow.current = next
        setPicked(next)
      })
      .catch((error: unknown) => {
        if (generation === preparationGeneration.current)
          setError(
            error instanceof Error &&
              (error.message === lstrings.chat_attachment_limit ||
                error.message.includes('too large'))
              ? error.message
              : lstrings.chat_attachment_failed
          )
      })
      .finally(() => {
        if (generation === preparationGeneration.current) {
          preparingNow.current -= 1
          setPreparing(preparingNow.current)
        }
      })
  }
  const explicitRead = useCallback(() => {
    const current = latestView.current
    if (
      current == null ||
      props.active === false ||
      !readDocumentActive() ||
      menu != null ||
      conversationMenu ||
      reacting != null ||
      pinsOpen ||
      isRestoringPopupFocus()
    )
      return
    readRevision.current =
      current.conversation.preferences?.manualUnreadRevision ?? 0
    engine.markRead(conversationId, readRevision.current).catch(() => undefined)
  }, [
    engine,
    conversationId,
    props.active,
    menu,
    conversationMenu,
    reacting,
    pinsOpen
  ])
  const hasView = view != null
  const userScrolled = useCallback(() => {
    if (!mounted.current || !paneActive.current) return
    jumpGeneration.current += 1
    measuringJump.current = undefined
    // Cancel the jump, not the older page's position compensation. The
    // response still adds rows above the position the person now chose.
    if (
      prepend.current != null &&
      latestView.current?.messages[0]?.seq === prepend.current.firstSeq
    ) {
      prepend.current.offset = scrolled.current.offset
      prepend.current.anchor = readingAnchor(prepend.current.positions)
    }
    atBottom.current = false
    restoreTarget.current = undefined
    restoreAnchor.current = undefined
    restoringAnchor.current = false
    restoreAnchorDirty.current = false
    scrolled.current.hasPosition = true
    scrolled.current.anchor = readingAnchor(messagePositions.current)
    onDraftChange?.({
      text: textNow.current,
      replyTo: replyNow.current,
      editing: editingNow.current,
      picked: pickedNow.current,
      scrollOffset: scrolled.current.offset,
      hasScrollPosition: true,
      followNewest: scrolled.current.followNewest,
      scrollAnchor: scrolled.current.anchor
    })
    explicitRead()
  }, [onDraftChange, explicitRead, readingAnchor])
  useEffect(
    () => bindUserScroll(scroller.current, userScrolled),
    [userScrolled, hasView]
  )
  useEffect(
    () => () => {
      jumpGeneration.current += 1
      measuringJump.current = undefined
      clearTimeout(highlightTimer.current)
    },
    [conversationId, props.active]
  )

  const loadOlder = async (): Promise<ConversationView> => {
    const before = engine.view(conversationId)
    prepend.current = {
      offset: scrolled.current.offset,
      content: scrolled.current.content,
      firstSeq: before?.messages[0]?.seq,
      positions: new Map(messagePositions.current),
      anchor: readingAnchor(messagePositions.current)
    }
    messagePositions.current.clear()
    atBottom.current = false
    try {
      const next = await engine.loadEarlier(conversationId)
      const firstSeq = next.messages[0]?.seq
      if (
        firstSeq == null ||
        (before?.messages[0] != null && firstSeq >= before.messages[0].seq)
      ) {
        // Edit/reaction-only pages can advance the raw cursor without new
        // rows. Keep known geometry for a following page's reading anchor.
        const present = new Set(next.messages.map(message => message.id))
        for (const [id, y] of prepend.current?.positions ?? [])
          if (present.has(id) && !messagePositions.current.has(id))
            messagePositions.current.set(id, y)
        prepend.current = undefined
      }
      return next
    } catch (error) {
      prepend.current = undefined
      throw error
    }
  }
  const measurePosition = async (
    id: string,
    cancelled: () => boolean
  ): Promise<number | undefined> => {
    const deadline = Date.now() + 2000
    while (!cancelled() && Date.now() < deadline) {
      const row = messageRefs.current.get(id)
      const content = scroller.current?.getInnerViewRef()
      const y = await new Promise<number | undefined>(resolve => {
        const timer = setTimeout(() => {
          resolve(undefined)
        }, 100)
        if (row == null || content == null) {
          clearTimeout(timer)
          resolve(undefined)
          return
        }
        row.measureLayout(
          content,
          (_x, top, width, height) => {
            clearTimeout(timer)
            resolve(
              Number.isFinite(top) && width > 0 && height > 0 ? top : undefined
            )
          },
          () => {
            clearTimeout(timer)
            resolve(messagePositions.current.get(id))
          }
        )
      })
      if (cancelled()) return undefined
      if (y != null) return y
      await new Promise<void>(resolve => setTimeout(resolve, 25))
    }
    return undefined
  }
  const rememberPosition = (
    target: number,
    anchor = scrolled.current.anchor
  ): void => {
    restoreTarget.current = target
    scrolled.current.offset = target
    scrolled.current.hasPosition = true
    scrolled.current.followNewest = false
    scrolled.current.anchor = anchor
    restoreAnchor.current = anchor
    onDraftChange?.({
      text: textNow.current,
      replyTo: replyNow.current,
      editing: editingNow.current,
      picked: pickedNow.current,
      scrollOffset: target,
      hasScrollPosition: true,
      followNewest: false,
      scrollAnchor: scrolled.current.anchor
    })
  }
  const restoreReadingAnchor = (): void => {
    const anchor = restoreAnchor.current
    if (
      anchor == null ||
      measuringJump.current != null ||
      !mounted.current ||
      !paneActive.current
    )
      return
    if (restoringAnchor.current) {
      restoreAnchorDirty.current = true
      return
    }
    const generation = jumpGeneration.current
    restoringAnchor.current = true
    restoreAnchorDirty.current = false
    const cancelled = (): boolean =>
      !mounted.current ||
      !paneActive.current ||
      generation !== jumpGeneration.current ||
      restoreAnchor.current !== anchor
    measurePosition(anchor.id, cancelled)
      .then(y => {
        if (y == null || cancelled() || restoreAnchorDirty.current) return
        const target = Math.max(0, y - anchor.relativeY)
        rememberPosition(target, anchor)
        scroller.current?.scrollTo({ y: target, animated: false })
      })
      .catch(() => undefined)
      .finally(() => {
        if (generation === jumpGeneration.current) {
          restoringAnchor.current = false
          if (restoreAnchorDirty.current && !cancelled()) restoreReadingAnchor()
        }
      })
  }
  const jumpTo = (id: string): void => {
    restoreTarget.current = undefined
    restoreAnchor.current = undefined
    restoringAnchor.current = false
    restoreAnchorDirty.current = false
    const generation = ++jumpGeneration.current
    measuringJump.current = generation
    setPinsOpen(false)
    setError(undefined)
    atBottom.current = false
    findOriginal(
      { view: engine.view.bind(engine), loadEarlier: loadOlder },
      conversationId,
      id,
      () => generation !== jumpGeneration.current || props.active === false
    )
      .then(async original => {
        if (generation !== jumpGeneration.current) return
        if (original == null) {
          measuringJump.current = undefined
          setError(lstrings.chat_message_unavailable)
          return
        }
        // Measure the mounted row relative to scroll content. Paging resolves
        // before native/DOM layout, so wait for actual geometry, not a guessed delay.
        prepend.current = undefined
        const cancelled = (): boolean =>
          generation !== jumpGeneration.current ||
          !mounted.current ||
          !paneActive.current ||
          engine.view(conversationId) == null
        const y = await measurePosition(id, cancelled)
        if (cancelled()) {
          if (measuringJump.current === generation)
            measuringJump.current = undefined
          return
        }
        measuringJump.current = undefined
        if (y == null) {
          setError(lstrings.chat_message_unavailable)
          return
        }
        const target = Math.max(0, y - theme.rem(0.5))
        restoreTarget.current = target
        scrolled.current.offset = target
        scrolled.current.hasPosition = true
        scrolled.current.followNewest = false
        scrolled.current.anchor = { id, relativeY: y - target }
        restoreAnchor.current = scrolled.current.anchor
        onDraftChange?.({
          text: textNow.current,
          replyTo: replyNow.current,
          editing: editingNow.current,
          picked: pickedNow.current,
          scrollOffset: target,
          hasScrollPosition: true,
          followNewest: false,
          scrollAnchor: scrolled.current.anchor
        })
        scroller.current?.scrollTo({
          y: target,
          animated: true
        })
        setHighlight(id)
        clearTimeout(highlightTimer.current)
        highlightTimer.current = setTimeout(() => {
          setHighlight(undefined)
        }, 1500)
      })
      .catch(() => {
        if (generation === jumpGeneration.current) {
          measuringJump.current = undefined
          setError(lstrings.chat_message_unavailable)
        }
      })
  }

  useEffect(() => {
    const next = {
      text,
      replyTo,
      editing,
      picked,
      scrollOffset: scrolled.current.offset,
      hasScrollPosition: scrolled.current.hasPosition,
      followNewest: scrolled.current.followNewest,
      scrollAnchor: scrolled.current.anchor
    }
    draftOwner.write(conversationId, next)
    onDraftChange?.(next)
  }, [
    text,
    replyTo,
    editing,
    picked,
    onDraftChange,
    draftOwner,
    conversationId
  ])

  // Open the chat, and keep its view current from the engine's events. A
  // chat the list does not hold yet (a newcomer, a moment before the server
  // has added them) is opened again as soon as the list brings it, and
  // every few seconds until then.
  useEffect(() => {
    if (!mounted.current || !paneActive.current) return
    restoreTarget.current =
      scrolled.current.hasPosition && !scrolled.current.followNewest
        ? scrolled.current.offset
        : undefined
    restoreAnchor.current =
      scrolled.current.hasPosition && !scrolled.current.followNewest
        ? scrolled.current.anchor
        : undefined
    restoringAnchor.current = false
    restoreAnchorDirty.current = false
    atBottom.current = restoreTarget.current == null
    let live = true
    let opened = false
    let opening = false
    let tries = 0
    setView(undefined)
    setFailed(false)
    const waiting = (): GrantApproval[] =>
      approvalsIn(engine.approvals(), conversationId, userId)
    setApprovals(waiting())
    // Until it is open, the chat as the list last described it: its title,
    // and whether this device holds its key (History is locked) or not.
    const listed = (): void => {
      const known = engine.view(conversationId)
      if (known != null && live) {
        readRevision.current ??=
          known.conversation.preferences?.manualUnreadRevision ?? 0
        setView(known)
      }
    }
    const tryOpen = (): void => {
      if (opened || opening || !live) return
      listed()
      opening = true
      tries += 1
      engine
        .open(conversationId)
        .then(next => {
          opened = true
          if (live) {
            setView(next)
            readRevision.current ??=
              next.conversation.preferences?.manualUnreadRevision ?? 0
            setFailed(false)
          }
        })
        .catch(() => {
          if (live && tries >= OPEN_TRIES) setFailed(true)
        })
        .finally(() => {
          opening = false
        })
    }
    const unsubscribe = engine.subscribe(event => {
      if (!live) return
      if (event.type === 'approvals') setApprovals(waiting())
      if (
        (event.type === 'conversation' &&
          event.conversationId === conversationId) ||
        event.type === 'conversations'
      ) {
        if (!opened) {
          tryOpen()
          return
        }
        const next = engine.view(conversationId)
        if (next != null) setView(next)
        else {
          setView(undefined)
          setFailed(true)
          setMenu(undefined)
          setConversationMenu(false)
        }
      }
    })
    tryOpen()
    const timer = setInterval(tryOpen, OPEN_RETRY_MS)
    return () => {
      live = false
      clearInterval(timer)
      unsubscribe()
      engine.close(conversationId)
    }
  }, [engine, conversationId, userId, props.active])

  const title = view?.conversation.title
  useEffect(() => {
    if (title != null && title !== '') onTitle?.(title)
  }, [onTitle, title])

  // What is on the screen has been read.
  const newest = view?.messages.at(-1)?.seq ?? 0
  const unread = view?.conversation.unread ?? 0
  const manualUnread = view?.conversation.preferences?.manualUnread === true
  useEffect(() => {
    if (
      props.active === false ||
      !documentActive ||
      menu != null ||
      conversationMenu ||
      pinsOpen ||
      reacting != null
    )
      return
    if (newest === 0 && unread === 0 && !manualUnread) return
    engine.markRead(conversationId, readRevision.current).catch(() => undefined)
  }, [
    engine,
    conversationId,
    newest,
    unread,
    manualUnread,
    props.active,
    documentActive,
    menu,
    conversationMenu,
    pinsOpen,
    reacting
  ])
  useEffect(() => {
    readRevision.current = undefined
    const current = engine.view(conversationId)
    if (current == null) return
    readRevision.current =
      current.conversation.preferences?.manualUnreadRevision ?? 0
    if (!paneActive.current || !readDocumentActive()) return
    engine.markRead(conversationId, readRevision.current).catch(() => undefined)
  }, [props.readingSession, engine, conversationId])

  const run = useCallback(
    (work: () => Promise<unknown>, failure = lstrings.chat_send_failed) => {
      setError(undefined)
      setReported(false)
      work().catch(() => {
        setError(failure)
      })
    },
    []
  )

  if (failed && view == null) {
    return (
      <Screen>
        <Text style={shared.error}>{lstrings.chat_cannot_load}</Text>
      </Screen>
    )
  }
  if (view == null) {
    return (
      <Screen>
        <Text style={shared.muted}>{lstrings.common_loading}</Text>
      </Screen>
    )
  }

  const send = (): void => {
    if (
      !sendAllowed({
        enabled: view.composer === 'enabled' && props.active !== false,
        sending: draftOwner.isSending(conversationId),
        preparing: preparingNow.current > 0,
        text: textNow.current,
        attachments: pickedNow.current
      })
    )
      return
    const submission = draftOwner.begin(conversationId)
    if (submission == null) return
    const submitted = submission.draft
    const body = submitted.text.trim()
    const work = async (): Promise<unknown> => {
      if (submitted.editing != null) {
        await engine.edit(conversationId, submitted.editing.id, body)
        return
      }
      const quote =
        submitted.replyTo == null ? {} : { quoteId: submitted.replyTo.id }
      if (submitted.picked.length > 0) {
        return await engine.attach(
          conversationId,
          submitted.picked,
          body,
          quote
        )
      }
      return await engine.sendText(conversationId, body, quote)
    }
    const finish = (success: boolean): void => {
      const next = draftOwner.finish(conversationId, submission, success)
      // Standalone consumers retain their external draft callback; workspaces
      // reconcile directly in their persistent owner, never the old screen.
      if (props.draftOwner == null && next != null) props.onDraftChange?.(next)
    }
    work().then(
      () => {
        finish(true)
      },
      () => {
        finish(false)
      }
    )
  }

  const onText = (next: string): void => {
    textNow.current = next
    draftOwner.write(conversationId, {
      ...draftOwner.draft(conversationId),
      text: next
    })
    setText(next)
    readRevision.current =
      view.conversation.preferences?.manualUnreadRevision ?? 0
    if (readDocumentActive())
      engine
        .markRead(conversationId, readRevision.current)
        .catch(() => undefined)
    if (next !== '' && view.composer === 'enabled') {
      engine.typing(conversationId)
    }
  }

  const react = (message: MessageView, emoji: string, remove = false): void => {
    const current = engine.view(conversationId)
    const target = current?.messages.find(item => item.id === message.id)
    if (
      target == null ||
      current == null ||
      !actionsFor(target, current).includes('react')
    )
      return
    run(async () => {
      await engine.react(conversationId, target.id, emoji, remove)
    })
  }

  const nameOf = (message: MessageView): string =>
    message.mine
      ? lstrings.chat_you
      : (message.senderName ?? lstrings.chat_former_member)

  // Where a notice falls among the messages: a safety number change by its
  // time, and the end of what can be opened after the last lost message.
  const notices = new Map<number, Notice[]>()
  const addNotice = (index: number, notice: Notice): void => {
    notices.set(index, [...(notices.get(index) ?? []), notice])
  }
  if (view.earlierLost) {
    let lastLost = -1
    view.messages.forEach((message, index) => {
      if (message.status === 'lost') lastLost = index
    })
    addNotice(lastLost + 1, { kind: 'lost', key: 'lost' })
  }
  for (const change of view.safetyChanges) {
    let index = view.messages.findIndex(
      message => Date.parse(message.sentAt) > change.at
    )
    if (index === -1) index = view.messages.length
    addNotice(index, {
      kind: 'safety',
      key: `safety-${change.seq}`,
      name: change.name
    })
  }

  const renderNotice = (notice: Notice): React.ReactElement => (
    <View key={notice.key} style={styles.notice}>
      <Text style={styles.noticeText}>
        {notice.kind === 'lost'
          ? lstrings.chat_earlier_lost
          : sprintf(
              lstrings.chat_safety_changed,
              notice.name ?? lstrings.chat_former_member
            )}
      </Text>
    </View>
  )

  const typing = typingNames(view.typing, lstrings.chat_someone)
  const currentMenu =
    menu == null
      ? undefined
      : view.messages.find(message => message.id === menu.id)
  const selectedFor = (action: MessageAction): MessageView | undefined => {
    const current = engine.view(conversationId)
    const selected = current?.messages.find(message => message.id === menu?.id)
    if (
      current == null ||
      selected == null ||
      !actionsFor(selected, current).includes(action)
    ) {
      setError(lstrings.chat_message_unavailable)
      setMenu(undefined)
      return undefined
    }
    return selected
  }

  const rememberScroll = (
    event: NativeSyntheticEvent<NativeScrollEvent>
  ): void => {
    if (!mounted.current || !paneActive.current) return
    const { contentOffset, layoutMeasurement } = event.nativeEvent
    if (restoreTarget.current != null) return
    scrolled.current.offset = Math.max(0, contentOffset.y)
    const pending = prepend.current
    if (
      pending != null &&
      latestView.current?.messages[0]?.seq === pending.firstSeq &&
      Math.abs(scrolled.current.content - pending.content) < 1
    ) {
      pending.offset = scrolled.current.offset
      pending.anchor = readingAnchor(pending.positions)
    }
    scrolled.current.hasPosition = true
    // Native scroll events can carry the temporary viewport geometry
    // from a hidden pane or a keyboard transition. Keep the current
    // onLayout height while still recording the actual scroll offset.
    if (scrolled.current.height <= 0)
      scrolled.current.height = layoutMeasurement.height
    scrolled.current.followNewest =
      scrolled.current.offset + scrolled.current.height >=
      scrolled.current.content - 48
    scrolled.current.anchor = readingAnchor(messagePositions.current)
    props.onDraftChange?.({
      text: textNow.current,
      replyTo: replyNow.current,
      editing: editingNow.current,
      picked: pickedNow.current,
      scrollOffset: scrolled.current.offset,
      hasScrollPosition: true,
      followNewest: scrolled.current.followNewest,
      scrollAnchor: scrolled.current.anchor
    })
  }

  const content = (
    <>
      <View style={[styles.fill, { paddingBottom: lift }]}>
        <View style={styles.top}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={shared.heading} numberOfLines={1}>
              {conversationTitle(view.conversation)}
            </Text>
            {conversationPill(view.conversation) != null && (
              <Text style={shared.small}>
                {conversationPill(view.conversation)}
              </Text>
            )}
            <Text style={styles.count}>
              {plural(
                view.conversation.memberCount,
                lstrings.chat_members_count_one,
                lstrings.chat_members_count_many
              )}
            </Text>
          </View>
          <Button
            label={lstrings.chat_members}
            kind="text"
            compact
            icon="group"
            onPress={onMembers}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={lstrings.chat_conversation_actions}
            onPress={() => {
              setConversationMenu(true)
            }}
            style={{ padding: theme.rem(0.75) }}
          >
            <Text
              style={{
                color: theme.primaryTextColor,
                fontSize: theme.rem(1.125),
                letterSpacing: 2
              }}
            >
              •••
            </Text>
          </Pressable>
        </View>
        {(view.pins?.length ?? 0) > 0 && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${lstrings.chat_pinned_messages}: ${view.pins!.length}`}
            onPress={() => {
              setPinsOpen(true)
            }}
            style={{ paddingVertical: theme.rem(0.25) }}
          >
            <Text style={shared.small}>
              ⌖ {lstrings.chat_pinned_messages} ({view.pins!.length})
            </Text>
          </Pressable>
        )}
        {view.historyLocked && (
          <View style={[shared.banner, shared.bannerWarning]}>
            <Icon name="lock" color={theme.warningColor} />
            <Text style={shared.bannerText}>
              {lstrings.chat_history_locked}
            </Text>
          </View>
        )}
        {approvals.map(approval => (
          <View key={approval.requestId} style={shared.banner}>
            <Text style={shared.bannerText}>
              {sprintf(
                lstrings.chat_approval_request,
                approval.name ?? lstrings.chat_former_member
              )}
            </Text>
            <Button
              label={lstrings.chat_review}
              kind="secondary"
              compact
              onPress={onMembers}
            />
          </View>
        ))}
        {view.unverified && (
          <View style={[shared.banner, shared.bannerWarning]}>
            <Text style={shared.bannerText}>{lstrings.chat_unverified}</Text>
          </View>
        )}
        <ScrollView
          ref={scroller}
          style={styles.fill}
          contentContainerStyle={styles.messages}
          keyboardShouldPersistTaps="handled"
          onScroll={event => {
            gestureGeneration.current += 1
            rememberScroll(event)
          }}
          // A throttled Android stream need not send its last edge offset.
          // End events carry the authoritative settled position.
          onScrollEndDrag={rememberScroll}
          onMomentumScrollEnd={rememberScroll}
          onScrollBeginDrag={() => {
            gestureGeneration.current += 1
            if (Platform.OS !== 'web') userScrolled()
          }}
          onLayout={event => {
            if (!mounted.current || !paneActive.current) return
            scrolled.current.height = event.nativeEvent.layout.height
            if (restoreTarget.current != null)
              scroller.current?.scrollTo({
                y: restoreTarget.current,
                animated: false
              })
            restoreReadingAnchor()
          }}
          scrollEventThrottle={100}
          onContentSizeChange={(_width, height) => {
            if (!mounted.current || !paneActive.current) return
            if (prepend.current != null) {
              const previous = prepend.current
              const firstSeq = view.messages[0]?.seq
              if (
                firstSeq != null &&
                (previous.firstSeq == null || firstSeq < previous.firstSeq)
              ) {
                prepend.current = undefined
                const target = Math.max(
                  0,
                  previous.offset + height - previous.content
                )
                scrolled.current.content = height
                rememberPosition(target)
                scroller.current?.scrollTo({ y: target, animated: false })
                if (previous.anchor != null && measuringJump.current == null) {
                  const anchor = previous.anchor
                  const generation = jumpGeneration.current
                  const cancelled = (): boolean =>
                    generation !== jumpGeneration.current ||
                    !mounted.current ||
                    !paneActive.current ||
                    engine.view(conversationId) == null
                  // Total height also includes quote/image changes below the
                  // reader. Preserve the same existing row's viewport position.
                  measurePosition(anchor.id, cancelled)
                    .then(y => {
                      if (y == null || cancelled()) return
                      const measured = Math.max(0, y - anchor.relativeY)
                      rememberPosition(measured, anchor)
                      scroller.current?.scrollTo({
                        y: measured,
                        animated: false
                      })
                    })
                    .catch(() => undefined)
                }
                return
              }
              // An appended post or a layout pass is not an older page.
              // Exclude its height from the eventual prepend compensation.
              previous.content = height
            }
            if (restoreTarget.current != null) {
              scrolled.current.content = height
              scroller.current?.scrollTo({
                y: restoreTarget.current,
                animated: false
              })
              restoreReadingAnchor()
              return
            }
            if (measuringJump.current != null) {
              scrolled.current.content = height
              return
            }
            const { offset, content } = scrolled.current
            // At the bottom of what was there before it grew (or asked to
            // go there by a send): follow it down.
            const following =
              atBottom.current ||
              content === 0 ||
              offset + scrolled.current.height >= content - 48
            scrolled.current.content = height
            atBottom.current = false
            if (following) scroller.current?.scrollToEnd({ animated: false })
          }}
        >
          {view.hasEarlier && (
            <Button
              label={lstrings.chat_load_earlier}
              kind="text"
              onPress={() => {
                atBottom.current = false
                run(async () => {
                  await loadOlder()
                })
              }}
            />
          )}
          {view.messages.length === 0 && !view.earlierLost && (
            <Text style={[shared.muted, styles.empty]}>
              {lstrings.chat_no_messages}
            </Text>
          )}
          {view.messages.map((message, index) => (
            <View
              key={message.id}
              ref={node => {
                if (node == null) messageRefs.current.delete(message.id)
                else messageRefs.current.set(message.id, node)
              }}
              collapsable={false}
              onLayout={event => {
                const y = event.nativeEvent.layout.y
                messagePositions.current.set(message.id, y)
                if (view.messages[0]?.seq === prepend.current?.firstSeq)
                  prepend.current?.positions.set(message.id, y)
                if (message.id === restoreAnchor.current?.id)
                  restoreReadingAnchor()
              }}
            >
              {notices.get(index)?.map(renderNotice)}
              <MessageBubble
                message={message}
                conversation={view.conversation}
                members={view.members}
                engine={engine}
                files={files}
                maxWidth={bubbleWidth}
                swipe={swipe && view.composer === 'enabled'}
                actions={actionsFor(message, view)}
                pinned={view.pins?.some(pin => pin.messageId === message.id)}
                userId={userId}
                onJump={jumpTo}
                highlighted={highlight === message.id}
                gestureGeneration={gestureGeneration}
                onLongPress={(pressed, anchor) => {
                  if (actionsFor(pressed, view).length > 0) {
                    setMenu(pressed)
                    setMenuAnchor(anchor)
                  }
                }}
                onReact={pressed => {
                  setReacting(pressed)
                }}
                onReply={pressed => {
                  const current = engine.view(conversationId)
                  const original = current?.messages.find(
                    message => message.id === pressed.id
                  )
                  if (
                    current == null ||
                    original == null ||
                    !actionsFor(original, current).includes('reply')
                  )
                    return
                  setEditing(undefined)
                  replyNow.current = original
                  setReplyTo(original)
                }}
                onToggleReaction={(pressed, emoji, mine) => {
                  react(pressed, emoji, mine)
                }}
              />
            </View>
          ))}
          {notices.get(view.messages.length)?.map(renderNotice)}
        </ScrollView>
        {typing.length > 0 && (
          <Text style={shared.small} accessibilityLiveRegion="polite">
            {typing.length === 1
              ? sprintf(lstrings.chat_typing_one, typing[0])
              : sprintf(lstrings.chat_typing_many, typing.join(', '))}
          </Text>
        )}
        {error != null && <Text style={shared.error}>{error}</Text>}
        {reported && (
          <Text style={shared.muted} accessibilityLiveRegion="polite">
            {lstrings.chat_reported}
          </Text>
        )}
        {view.composer === 'closed' ? (
          <View style={shared.banner}>
            <Text style={shared.bannerText}>{lstrings.chat_closed_notice}</Text>
          </View>
        ) : view.composer === 'readOnly' ? (
          <View style={shared.banner}>
            <Text style={shared.bannerText}>{lstrings.chat_read_only}</Text>
          </View>
        ) : (
          <Composer
            onRead={() => {
              if (
                props.active === false ||
                !readDocumentActive() ||
                isRestoringPopupFocus()
              )
                return
              readRevision.current =
                view.conversation.preferences?.manualUnreadRevision ?? 0
              engine
                .markRead(conversationId, readRevision.current)
                .catch(() => undefined)
            }}
            text={text}
            onText={onText}
            enabled={view.composer === 'enabled'}
            sending={sending}
            preparing={preparing > 0}
            context={
              editing != null
                ? { kind: 'edit' }
                : replyTo != null
                  ? {
                      kind: 'reply',
                      name: nameOf(
                        view.messages.find(
                          message => message.id === replyTo.id
                        ) ?? { ...replyTo, senderName: undefined }
                      ),
                      snippet: replyExcerpt(
                        view.messages.find(message => message.id === replyTo.id)
                      )
                    }
                  : undefined
            }
            onCancelContext={() => {
              if (editing != null) setText('')
              setEditing(undefined)
              replyNow.current = undefined
              setReplyTo(undefined)
            }}
            attachments={picked}
            onRemoveAttachment={index => {
              const next = pickedNow.current.filter((_, at) => at !== index)
              pickedNow.current = next
              setPicked(next)
            }}
            sources={editing == null ? files.PICK_SOURCES : []}
            onAttach={source => {
              prepareFiles(
                async remaining => await files.pickFiles(source, remaining)
              )
            }}
            onSend={send}
          />
        )}
      </View>
      {conversationMenu && (
        <ConversationMenu
          conversation={view.conversation}
          engine={engine}
          onClose={() => {
            setConversationMenu(false)
          }}
        />
      )}
      {currentMenu != null && (
        <MessageMenu
          message={currentMenu}
          actions={actionsFor(currentMenu, view)}
          desktop={isFinePointer() && menuAnchor != null}
          anchor={menuAnchor}
          selected={
            <MessageBubble
              message={currentMenu}
              conversation={view.conversation}
              members={view.members}
              engine={engine}
              files={files}
              maxWidth={bubbleWidth}
              swipe={false}
              selected
              actions={[]}
              userId={userId}
              pinned={view.pins?.some(pin => pin.messageId === currentMenu.id)}
              onLongPress={() => {}}
              onReply={() => {}}
              onToggleReaction={() => {}}
            />
          }
          onClose={() => {
            setMenu(undefined)
          }}
          onReply={() => {
            const selected = selectedFor('reply')
            if (selected == null) return
            setEditing(undefined)
            replyNow.current = selected
            setReplyTo(selected)
            setMenu(undefined)
          }}
          onReact={emoji => {
            const selected = selectedFor('react')
            if (selected == null) return
            react(
              selected,
              emoji,
              selected.reactions.some(
                reaction => reaction.emoji === emoji && reaction.mine
              )
            )
            setMenu(undefined)
          }}
          onMoreEmoji={() => {
            const selected = selectedFor('react')
            if (selected != null) setReacting(selected)
            setMenu(undefined)
          }}
          onCopy={async () => {
            const selected = selectedFor('copy')
            if (selected == null) throw new Error('Message unavailable')
            await copyChatText(selected.body)
          }}
          onPin={pinned => {
            const selected = selectedFor(pinned ? 'pin' : 'unpin')
            if (selected == null) return
            setMenu(undefined)
            run(async () => {
              if (engine.pinMessage == null) throw new Error('Pins unavailable')
              await engine.pinMessage(conversationId, selected.id, pinned)
            }, lstrings.chat_pin_failed)
          }}
          onDelete={() => {
            const selected = selectedFor('delete')
            if (selected == null) return
            setMenu(undefined)
            run(async () => {
              await engine.deleteMessage(conversationId, selected.id)
            })
          }}
          onDeleteForEveryone={() => {
            const selected = selectedFor('deleteForEveryone')
            if (selected == null) return
            setMenu(undefined)
            run(async () => {
              await engine.moderatorDelete(conversationId, selected.id)
            })
          }}
        />
      )}
      {pinsOpen && (
        <PinnedMessages
          pins={view.pins ?? []}
          messages={view.messages}
          onJump={jumpTo}
          onClose={() => {
            setPinsOpen(false)
          }}
        />
      )}
      {reacting != null && (
        <View style={styles.reactPicker}>
          <EmojiPicker
            onPick={emoji => {
              react(reacting, emoji)
              setReacting(undefined)
            }}
            onClose={() => {
              setReacting(undefined)
            }}
          />
        </View>
      )}
    </>
  )
  const pane =
    props.embedded === true ? (
      <View style={[styles.column, { padding: theme.rem(1), flex: 1 }]}>
        {content}
      </View>
    ) : (
      <Screen scroll={false} contentStyle={styles.column}>
        {content}
      </Screen>
    )
  return (
    <ChatDropTarget
      disabledReason={
        view.composer !== 'enabled' || editing != null || sending
          ? lstrings.chat_attachment_blocked
          : undefined
      }
      onPrepare={prepareFiles}
      onReject={setError}
    >
      {pane}
    </ChatDropTarget>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  // The screen's own column, grown to the window; its bottom padding is
  // what keeps the composer clear of the floating capsule on a phone.
  column: {
    flex: 1,
    // Centred in a wide window, as every other chat screen is.
    alignSelf: 'stretch',
    gap: theme.rem(theme.spaceSmRem)
  },
  fill: {
    flex: 1,
    gap: theme.rem(theme.spaceSmRem)
  },
  top: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between'
  },
  count: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.8125),
    color: theme.secondaryTextColor
  },
  messages: {
    gap: theme.rem(theme.spaceSmRem),
    paddingVertical: theme.rem(theme.spaceSmRem)
  },
  empty: {
    textAlign: 'center',
    paddingVertical: theme.rem(theme.spaceLgRem)
  },
  notice: {
    alignSelf: 'center',
    borderRadius: theme.rem(1),
    backgroundColor: theme.containerBackgroundColor,
    paddingHorizontal: theme.rem(0.75),
    paddingVertical: theme.rem(0.25)
  },
  noticeText: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.8125),
    color: theme.secondaryTextColor,
    textAlign: 'center'
  },
  reactPicker: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0
  }
}))
