import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Platform,
  ScrollView,
  Text,
  useWindowDimensions,
  View
} from 'react-native'

import { MAX_ATTACHMENTS } from '../../common/chatContent'
import { Button, Icon, Screen } from '../components'
import { GlassView } from '../components/GlassView'
import { useHeaderHandoff } from '../components/headerSlot'
import { useBreakpoint } from '../components/useBreakpoint'
import { edgeMarginRem } from '../layout/margins'
import { lstrings, sprintf } from '../locales/strings'
import { useInsets } from '../platform/safeArea'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import type { ChatFileOps } from './AttachmentView'
import { copyChatText } from './chatClipboard'
import { attachmentProblem, sendAllowed } from './chatComposeModel'
import { ChatConversationIdentity } from './ChatConversationIdentity'
import { ChatDropTarget } from './ChatDropTarget'
import * as platformFiles from './chatFiles'
import type { PickedFile, PickSource } from './chatFileTypes'
import { anchorAfterChromeChange } from './chatLayoutModel'
import {
  type ComposerChange,
  type ComposerSelection,
  insertMention,
  mentionIds,
  type MentionRequest,
  mentionRequest,
  type MentionToken,
  reconcileMentions
} from './chatMentionsModel'
import { endsIncomingRun } from './chatMessageRuns'
import type { MessageSource } from './chatMessageSource'
import {
  actionsFor,
  approvalsIn,
  type MessageAction,
  typingNames
} from './chatModel'
import { getChatStyles } from './chatStyles'
import { ChatViewport, useChatViewport } from './ChatViewport'
import {
  bindUserScroll,
  isFinePointer,
  isRestoringPopupFocus,
  readDocumentActive,
  readMessageScrollPosition,
  watchReadDocumentActive
} from './chatWebInteractions'
import {
  type ChatDraft,
  ChatDraftOwner,
  emptyChatDraft,
  newChatWorkspaceState
} from './chatWorkspaceModel'
import { Composer } from './Composer'
import { EmojiPicker } from './EmojiPicker'
import type { MessageView } from './engine/apply'
import type { ConversationView, GrantApproval } from './engine/engine'
import { findOriginal, replyExcerpt } from './engine/reply'
import { MentionPicker } from './MentionPicker'
import { MessageBubble } from './MessageBubble'
import { MessageMenu } from './MessageMenu'
import { PinnedMessages } from './PinnedMessages'
import { PinnedMessageSummary } from './PinnedMessageSummary'
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
  /** Conversation information and member security, from the identity. */
  onMembers: () => void
  /** The chat's title once it is known, for the header. */
  onTitle?: (title: string) => void
  /** The platform's attachments; `chatFiles` by default. */
  files?: ConversationFiles
  /** Swipe a message right to reply; on phones by default. */
  swipe?: boolean
  embedded?: boolean
  /** Wide workspaces keep their identity inside the conversation pane. */
  paneHeader?: boolean
  active?: boolean
  readingSession?: number
  draft?: ChatDraft
  draftOwner?: ChatDraftOwner
  onDraftChange?: (draft: ChatDraft) => void
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
  const breakpoint = useBreakpoint()
  const margin = theme.rem(edgeMarginRem(theme, breakpoint))
  const [paneHeaderHeight, setPaneHeaderHeight] = useState(theme.rem(3.5))
  const [composerHeight, setComposerHeight] = useState(theme.rem(3.25))
  const [pinHeight, setPinHeight] = useState(0)
  const viewport = useChatViewport({
    paneHeader: props.paneHeader === true ? paneHeaderHeight : 0,
    composer: composerHeight,
    pins: pinHeight
  })
  const readableTop = useRef(viewport.readableTop)
  readableTop.current = viewport.readableTop
  const focusComposer = useRef<(selection?: ComposerSelection) => void>(
    () => {}
  )
  const registerComposerFocus = useCallback(
    (focus: (selection?: ComposerSelection) => void): (() => void) => {
      focusComposer.current = focus
      return () => {
        if (focusComposer.current === focus) focusComposer.current = () => {}
      }
    },
    []
  )
  const identityPress = useRef(onMembers)
  identityPress.current = onMembers

  const [localDraftOwner] = useState(() => {
    const state = newChatWorkspaceState()
    state.drafts.set(conversationId, props.draft ?? emptyChatDraft())
    return new ChatDraftOwner(state)
  })
  const draftOwner = props.draftOwner ?? localDraftOwner
  const [view, setView] = useState<ConversationView | undefined>(undefined)
  const latestView = useRef<ConversationView | undefined>(undefined)
  latestView.current = view
  const hasPins = (view?.pins?.length ?? 0) > 0
  useEffect(() => {
    if (!hasPins) {
      setPinHeight(0)
      setPinsOpen(false)
    }
  }, [hasPins])
  const [failed, setFailed] = useState(false)
  const [text, setText] = useState(props.draft?.text ?? '')
  const textNow = useRef(text)
  textNow.current = text
  const [mentionTokens, setMentionTokens] = useState<
    MentionToken[] | undefined
  >(props.draft?.mentionTokens)
  const mentionTokensNow = useRef(mentionTokens)
  mentionTokensNow.current = mentionTokens
  const [mentionChoosing, setMentionChoosing] = useState<MentionRequest>()
  const [mentionError, setMentionError] = useState<string>()
  const reportDraft = props.onDraftChange
  const onDraftChange = useCallback(
    (next: ChatDraft): void => {
      const tokens = mentionTokensNow.current
      reportDraft?.({
        ...next,
        ...(tokens == null ? {} : { mentionTokens: tokens })
      })
    },
    [reportDraft]
  )
  useEffect(() => {
    if (props.active === false || view?.composer !== 'enabled')
      setMentionChoosing(undefined)
  }, [conversationId, props.active, view?.composer])
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
  const [menuSource, setMenuSource] = useState<MessageSource>()
  useEffect(() => {
    if (props.active === false) {
      setMenu(undefined)
      setMenuSource(undefined)
    }
  }, [props.active])
  const [pinsOpen, setPinsOpen] = useState(false)
  const [jumpRetry, setJumpRetry] = useState<string>()
  const [resolvingJump, setResolvingJump] = useState(false)
  useEffect(() => {
    setResolvingJump(false)
    setJumpRetry(undefined)
  }, [conversationId, props.active])
  const [highlight, setHighlight] = useState<string | undefined>(undefined)
  const jumpGeneration = useRef(0)
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined
  )
  const gestureGeneration = useRef(0)
  const gestureOffset = useRef({ x: 0, y: 0 })
  const nativeUserScroll = useRef<'drag' | 'momentum' | undefined>(undefined)
  const nativeMomentumFromDrag = useRef(false)
  const messagePositions = useRef(new Map<string, number>())
  const messageRefs = useRef(new Map<string, React.ComponentRef<typeof View>>())
  const measuringJump = useRef<number | undefined>(undefined)
  const prepend = useRef<
    | {
        offset: number
        content: number
        conversationId: string
        firstSeq: number | undefined
        firstId: string | undefined
        firstY: number | undefined
        hasEarlier: boolean | undefined
        exhausted: boolean
        headerRemoved: boolean
        checkingHeader: boolean
        headerCheckDirty: boolean
        capturingAnchor: boolean
        positions: Map<string, number>
        anchor: { id: string; relativeY: number } | undefined
      }
    | undefined
  >(undefined)
  const [reacting, setReacting] = useState<MessageView | undefined>(undefined)
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
          ...(mentionTokensNow.current == null
            ? {}
            : { mentionTokens: mentionTokensNow.current }),
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
          mentionTokensNow.current = next.mentionTokens
          setMentionTokens(next.mentionTokens)
          setMentionChoosing(undefined)
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
  const exhaustedPageRestorer = useRef<() => void>(() => {})
  const atBottom = useRef(
    !scrolled.current.hasPosition || scrolled.current.followNewest
  )
  const menuReading = useRef<
    | {
        offset: number
        anchor: { id: string; relativeY: number } | undefined
        top: number
      }
    | undefined
  >(undefined)
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
    work: (remaining: number) => Promise<PickedFile[]>,
    mode: 'queue' | 'picker' = 'queue'
  ): void => {
    if (mode === 'picker' && preparingNow.current > 0) return
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
    // The system picker must open in its trusted activation turn. Drops
    // still start in queue order with the current remaining capacity.
    const started =
      mode === 'picker'
        ? new Promise<PickedFile[]>(resolve => {
            resolve(work(MAX_ATTACHMENTS - pickedNow.current.length))
          }).then(
            chosen => ({ ok: true as const, chosen }),
            (error: unknown) => ({ ok: false as const, error })
          )
        : undefined
    preparationQueue.current = preparationQueue.current
      .catch(() => undefined)
      .then(async () => {
        if (generation !== preparationGeneration.current) return
        const outcome = started == null ? undefined : await started
        if (outcome?.ok === false) throw outcome.error
        const chosen =
          outcome == null
            ? await work(MAX_ATTACHMENTS - pickedNow.current.length)
            : outcome.chosen
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
      mentionChoosing != null ||
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
    reacting,
    pinsOpen,
    mentionChoosing
  ])
  const hasView = view != null
  const userScrolled = useCallback(() => {
    if (!mounted.current || !paneActive.current) return
    const generation = ++jumpGeneration.current
    measuringJump.current = undefined
    const visible = readMessageScrollPosition(
      scroller.current,
      messageRefs.current
    )
    if (visible != null) scrolled.current.offset = visible.offset
    // Cancel the jump, not the older page's position compensation. The
    // response still adds rows above the position the person now chose.
    const pending = prepend.current
    if (
      pending != null &&
      latestView.current?.messages[0]?.seq === pending.firstSeq
    ) {
      pending.offset = scrolled.current.offset
      pending.positions = new Map([
        ...pending.positions,
        ...messagePositions.current
      ])
      const anchor =
        visible == null ? readingAnchor(pending.positions) : visible.anchor
      pending.anchor = anchor
      pending.capturingAnchor = false
      if (visible == null && anchor != null) {
        pending.capturingAnchor = true
        const cancelled = (): boolean =>
          generation !== jumpGeneration.current ||
          prepend.current !== pending ||
          !mounted.current ||
          !paneActive.current
        // A position-only web layout need not emit a row onLayout event.
        // Capture the position the person chose from the mounted row.
        measurePosition(anchor.id, cancelled, true)
          .then(relativeY => {
            if (cancelled()) return
            pending.anchor =
              relativeY == null ? undefined : { id: anchor.id, relativeY }
          })
          .catch(() => {
            if (!cancelled()) pending.anchor = undefined
          })
          .finally(() => {
            if (cancelled()) return
            pending.capturingAnchor = false
            exhaustedPageRestorer.current()
          })
      }
    }
    setResolvingJump(false)
    atBottom.current = false
    restoreTarget.current = undefined
    restoreAnchor.current = undefined
    restoringAnchor.current = false
    restoreAnchorDirty.current = false
    scrolled.current.hasPosition = true
    scrolled.current.anchor =
      visible == null ? readingAnchor(messagePositions.current) : visible.anchor
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
    () =>
      bindUserScroll(
        scroller.current,
        userScrolled,
        offset => {
          scrolled.current.offset = offset
          userScrolled()
        },
        Platform.OS === 'web'
          ? () => {
              gestureGeneration.current += 1
            }
          : undefined
      ),
    [userScrolled, hasView]
  )
  useEffect(
    () => () => {
      jumpGeneration.current += 1
      measuringJump.current = undefined
      prepend.current = undefined
      nativeUserScroll.current = undefined
      nativeMomentumFromDrag.current = false
      restoringAnchor.current = false
      restoreAnchorDirty.current = false
      clearTimeout(highlightTimer.current)
    },
    [conversationId, props.active]
  )

  const loadOlder = async (
    cancelled: () => boolean = () => false
  ): Promise<ConversationView> => {
    const before = engine.view(conversationId)
    if (before == null) throw new Error('Conversation unavailable')
    if (cancelled()) return before
    const pending = {
      offset: scrolled.current.offset,
      content: scrolled.current.content,
      conversationId,
      firstSeq: before?.messages[0]?.seq,
      firstId: before?.messages[0]?.id,
      firstY:
        before?.messages[0] == null
          ? undefined
          : messagePositions.current.get(before.messages[0].id),
      hasEarlier: before?.hasEarlier,
      exhausted: false,
      headerRemoved: false,
      checkingHeader: false,
      headerCheckDirty: false,
      capturingAnchor: false,
      positions: new Map(messagePositions.current),
      anchor: readingAnchor(messagePositions.current)
    }
    prepend.current = pending
    messagePositions.current.clear()
    atBottom.current = false
    try {
      if (
        pending.anchor != null &&
        pending.firstId != null &&
        pending.firstY == null
      )
        pending.firstY = await measurePosition(
          pending.firstId,
          () =>
            prepend.current !== pending ||
            !mounted.current ||
            !paneActive.current
        )
      if (cancelled()) {
        if (prepend.current === pending) prepend.current = undefined
        return before
      }
      const next = await engine.loadEarlier(conversationId)
      // A cancelled jump must still preserve the reader when this response
      // removes the paging header or changes existing row geometry.
      const firstSeq = next.messages[0]?.seq
      if (
        firstSeq == null ||
        (before?.messages[0] != null && firstSeq >= before.messages[0].seq)
      ) {
        // Edit/reaction-only pages can advance the raw cursor without new
        // rows. Keep known geometry for a following page's reading anchor.
        if (prepend.current === pending) {
          const present = new Set(next.messages.map(message => message.id))
          for (const [id, y] of pending.positions)
            if (present.has(id) && !messagePositions.current.has(id))
              messagePositions.current.set(id, y)
          if (
            before.hasEarlier &&
            !next.hasEarlier &&
            mounted.current &&
            paneActive.current &&
            latestView.current?.conversation.id === conversationId
          ) {
            // Keep ownership through delayed header layout, so a user scroll
            // after page resolution can still replace the reading anchor.
            pending.exhausted = true
            restoreExhaustedPage()
          } else prepend.current = undefined
        }
      }
      return next
    } catch (error) {
      if (prepend.current === pending) prepend.current = undefined
      throw error
    }
  }
  const restoreExhaustedPage = (): void => {
    const pending = prepend.current
    if (pending?.exhausted !== true) return
    if (
      pending.anchor == null ||
      pending.firstId == null ||
      pending.firstY == null
    ) {
      // Without a measured reading anchor there is nothing to compensate.
      // Retire ownership so later layouts can capture a new reading anchor.
      prepend.current = undefined
      return
    }
    if (!pending.headerRemoved) {
      if (pending.checkingHeader) {
        pending.headerCheckDirty = true
        return
      }
      pending.checkingHeader = true
      pending.headerCheckDirty = false
      const firstY = pending.firstY
      const cancelled = (): boolean =>
        prepend.current !== pending ||
        !mounted.current ||
        !paneActive.current ||
        latestView.current?.conversation.id !== pending.conversationId
      // Content can also grow below the reader. Only a measured move of the
      // first row establishes that the paging header's layout has settled.
      measurePosition(pending.firstId, cancelled)
        .then(y => {
          if (!cancelled() && y != null && y < firstY)
            pending.headerRemoved = true
        })
        .catch(() => undefined)
        .finally(() => {
          pending.checkingHeader = false
          if (cancelled()) {
            pending.headerCheckDirty = false
            if (prepend.current === pending) prepend.current = undefined
            return
          }
          if (pending.headerRemoved || pending.headerCheckDirty)
            restoreExhaustedPage()
        })
      return
    }
    if (pending.capturingAnchor) return
    prepend.current = undefined
    if (
      pending.anchor != null &&
      mounted.current &&
      paneActive.current &&
      latestView.current?.conversation.id === pending.conversationId
    ) {
      restoreAnchor.current = pending.anchor
      restoreReadingAnchor()
    }
  }
  exhaustedPageRestorer.current = restoreExhaustedPage
  const measurePosition = async (
    id: string,
    cancelled: () => boolean,
    relativeToViewport = false
  ): Promise<number | undefined> => {
    const deadline = Date.now() + 2000
    while (!cancelled() && Date.now() < deadline) {
      const row = messageRefs.current.get(id)
      const content = relativeToViewport
        ? scroller.current?.getNativeScrollRef()
        : scroller.current?.getInnerViewRef()
      const y = await new Promise<number | undefined>(resolve => {
        const timer = setTimeout(() => {
          resolve(undefined)
        }, 100)
        if (row == null || content == null) {
          clearTimeout(timer)
          resolve(undefined)
          return
        }
        if (relativeToViewport) {
          let rowY: number | undefined
          let viewportY: number | undefined
          const finish = (): void => {
            if (rowY == null || viewportY == null) return
            clearTimeout(timer)
            resolve(rowY - viewportY)
          }
          // Native measureLayout excludes the ScrollView content transform.
          // Window measurements include the actual visible scroll position.
          row.measureInWindow((_x, top, width, height) => {
            if (Number.isFinite(top) && width > 0 && height > 0) rowY = top
            finish()
          })
          content.measureInWindow((_x, top, width, height) => {
            if (Number.isFinite(top) && width > 0 && height > 0) viewportY = top
            finish()
          })
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
  const reachableOffset = (target: number): number => {
    const { content, height } = scrolled.current
    return content > 0 && height > 0
      ? Math.min(Math.max(0, target), Math.max(0, content - height))
      : Math.max(0, target)
  }
  const rememberPosition = (
    requestedOffset: number,
    anchor = scrolled.current.anchor
  ): number => {
    const target = reachableOffset(requestedOffset)
    if (anchor != null && target !== requestedOffset)
      anchor = {
        id: anchor.id,
        relativeY: anchor.relativeY + requestedOffset - target
      }
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
    return target
  }
  const recaptureLiveAnchor = (): void => {
    const current = latestView.current
    if (
      !mounted.current ||
      !paneActive.current ||
      current?.conversation.id !== conversationId ||
      !scrolled.current.hasPosition ||
      menuReading.current != null ||
      scrolled.current.followNewest ||
      restoreTarget.current != null ||
      restoreAnchor.current != null ||
      prepend.current != null ||
      measuringJump.current != null
    )
      return
    const present = new Set(current.messages.map(message => message.id))
    const next = readingAnchor(
      new Map([...messagePositions.current].filter(([id]) => present.has(id)))
    )
    const previous = scrolled.current.anchor
    if (
      next == null ||
      (next.id === previous?.id && next.relativeY === previous.relativeY)
    )
      return
    scrolled.current.anchor = next
    onDraftChange?.({
      text: textNow.current,
      replyTo: replyNow.current,
      editing: editingNow.current,
      picked: pickedNow.current,
      scrollOffset: scrolled.current.offset,
      hasScrollPosition: true,
      followNewest: false,
      scrollAnchor: next
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
        const target = rememberPosition(
          Math.max(0, y - anchor.relativeY),
          anchor
        )
        scroller.current?.scrollTo({ y: target, animated: false })
      })
      .catch(() => undefined)
      .finally(() => {
        if (generation === jumpGeneration.current) {
          restoringAnchor.current = false
          // A replacement anchor cancels this measurement, but still needs
          // its own measurement after the old one retires.
          if (restoreAnchorDirty.current) restoreReadingAnchor()
        }
      })
  }
  const jumpTo = (id: string): void => {
    if (
      !mounted.current ||
      !paneActive.current ||
      engine.view(conversationId) == null
    )
      return
    setJumpRetry(undefined)
    setResolvingJump(true)
    nativeUserScroll.current = undefined
    nativeMomentumFromDrag.current = false
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
      {
        view: engine.view.bind(engine),
        loadEarlier: async () =>
          await loadOlder(
            () =>
              generation !== jumpGeneration.current ||
              !mounted.current ||
              !paneActive.current
          )
      },
      conversationId,
      id,
      () => generation !== jumpGeneration.current || props.active === false
    )
      .then(async original => {
        if (generation !== jumpGeneration.current) return
        if (original?.status !== 'ok') {
          measuringJump.current = undefined
          setResolvingJump(false)
          setJumpRetry(id)
          setError(lstrings.chat_message_unavailable)
          restoreReadingAnchor()
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
        setResolvingJump(false)
        const current = engine
          .view(conversationId)
          ?.messages.find(message => message.id === id)
        if (y == null || current?.status !== 'ok') {
          setJumpRetry(id)
          setError(lstrings.chat_message_unavailable)
          return
        }
        const target = rememberPosition(
          Math.max(0, y - readableTop.current - theme.rem(0.5)),
          {
            id,
            relativeY: readableTop.current + theme.rem(0.5)
          }
        )
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
          setResolvingJump(false)
          setJumpRetry(id)
          setError(lstrings.chat_message_unavailable)
          restoreReadingAnchor()
        }
      })
  }

  useEffect(() => {
    const next = {
      text,
      ...(mentionTokens == null ? {} : { mentionTokens }),
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
    mentionTokens,
    replyTo,
    editing,
    picked,
    onDraftChange,
    draftOwner,
    conversationId
  ])

  const restoreForGeometry = useRef(restoreReadingAnchor)
  restoreForGeometry.current = restoreReadingAnchor
  useEffect(() => {
    if (
      menuReading.current == null ||
      (menu != null &&
        props.active !== false &&
        view?.messages.some(message => message.id === menu.id) === true)
    )
      return
    const held = menuReading.current
    menuReading.current = undefined
    restoreTarget.current = undefined
    restoreAnchor.current = undefined
    restoringAnchor.current = false
    restoreAnchorDirty.current = false
    const adjusted =
      held.anchor == null
        ? undefined
        : {
            ...held.anchor,
            relativeY: anchorAfterChromeChange(
              held.anchor.relativeY,
              held.top,
              readableTop.current,
              theme.rem(0.5)
            )
          }
    if (adjusted != null && adjusted.relativeY !== held.anchor?.relativeY) {
      // Chrome that arrived during the lift only uncovers the row after exit.
      restoreAnchor.current = adjusted
      atBottom.current = false
      restoreForGeometry.current()
      return
    }
    // Dismissal resumes following only if the reader still occupies the end.
    // Arrivals while the actions were open must remain below that reader.
    scrolled.current.followNewest =
      scrolled.current.offset + scrolled.current.height >=
      scrolled.current.content - 48
    atBottom.current = scrolled.current.followNewest
  }, [menu, view?.messages, props.active, theme])
  const previousClearances = useRef({
    top: viewport.readableTop,
    bottom: viewport.contentBottom
  })
  useEffect(() => {
    const previous = previousClearances.current
    previousClearances.current = {
      top: viewport.readableTop,
      bottom: viewport.contentBottom
    }
    if (
      previous.top === viewport.readableTop &&
      previous.bottom === viewport.contentBottom
    )
      return
    if (
      !mounted.current ||
      !paneActive.current ||
      !scrolled.current.hasPosition
    )
      return
    if (menuReading.current != null) {
      restoreAnchor.current = menuReading.current.anchor
      restoreForGeometry.current()
      return
    }
    if (scrolled.current.followNewest || atBottom.current) {
      scroller.current?.scrollToEnd({ animated: false })
      return
    }
    const anchor = scrolled.current.anchor
    if (anchor != null) {
      restoreAnchor.current = {
        ...anchor,
        relativeY: anchorAfterChromeChange(
          anchor.relativeY,
          previous.top,
          viewport.readableTop,
          theme.rem(0.5)
        )
      }
      restoreForGeometry.current()
    }
  }, [viewport.readableTop, viewport.contentBottom, theme])

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
  const headerConversation = view?.conversation
  useHeaderHandoff(
    useMemo(
      () =>
        headerConversation != null &&
        props.active !== false &&
        props.paneHeader !== true ? (
          <ChatConversationIdentity
            conversation={headerConversation}
            onPress={() => {
              identityPress.current()
            }}
          />
        ) : null,
      [headerConversation, props.active, props.paneHeader]
    ),
    props.active !== false && props.paneHeader !== true
      ? Math.max(theme.rem(3), theme.rem(2.25) * window.fontScale)
      : 0
  )

  // What is on the screen has been read.
  const newest = view?.messages.at(-1)?.seq ?? 0
  const unread = view?.conversation.unread ?? 0
  const manualUnread = view?.conversation.preferences?.manualUnread === true
  useEffect(() => {
    if (
      props.active === false ||
      !documentActive ||
      menu != null ||
      mentionChoosing != null ||
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
    mentionChoosing,
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
    const current = engine.view(conversationId)
    if (current?.composer !== 'enabled') return
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
    const mentions = mentionIds(
      submitted.text,
      submitted.mentionTokens,
      current.members,
      submitted.editing
    )
    const work = async (): Promise<unknown> => {
      if (submitted.editing != null) {
        if (mentions.length > 0)
          await engine.edit(
            conversationId,
            submitted.editing.id,
            body,
            mentions
          )
        else await engine.edit(conversationId, submitted.editing.id, body)
        return
      }
      const quote = {
        ...(submitted.replyTo == null ? {} : { quoteId: submitted.replyTo.id }),
        ...(mentions.length === 0 ? {} : { mentions })
      }
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

  const onText = (next: string, change?: ComposerChange): void => {
    const before = textNow.current
    const reconciled = reconcileMentions(
      before,
      next,
      mentionTokensNow.current,
      change
    )
    const tokens =
      mentionTokensNow.current == null && reconciled.length === 0
        ? undefined
        : reconciled
    mentionTokensNow.current = tokens
    setMentionTokens(tokens)
    const choosing =
      view.composer === 'enabled' &&
      props.active !== false &&
      engine.view(conversationId)?.composer === 'enabled'
        ? mentionRequest(before, next, change)
        : undefined
    setMentionChoosing(choosing)
    setMentionError(undefined)
    textNow.current = next
    draftOwner.write(conversationId, {
      ...draftOwner.draft(conversationId),
      text: next,
      ...(tokens == null ? {} : { mentionTokens: tokens })
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

  const chooseMention = (userId: number): void => {
    const current = engine.view(conversationId)
    const member = current?.members.find(member => member.userId === userId)
    if (
      props.active === false ||
      current?.composer !== 'enabled' ||
      member == null ||
      mentionChoosing == null
    ) {
      setMentionChoosing(undefined)
      return
    }
    const next = insertMention(
      mentionChoosing,
      textNow.current,
      mentionTokensNow.current,
      member
    )
    if (next == null) {
      setMentionError(lstrings.chat_mention_too_long)
      return
    }
    textNow.current = next.text
    mentionTokensNow.current = next.tokens
    setText(next.text)
    setMentionTokens(next.tokens)
    draftOwner.write(conversationId, {
      ...draftOwner.draft(conversationId),
      text: next.text,
      mentionTokens: next.tokens
    })
    setMentionChoosing(undefined)
    setMentionError(undefined)
    focusComposer.current(next.selection)
  }

  const reply = (pressed: MessageView): void => {
    const current = engine.view(conversationId)
    const original = current?.messages.find(
      message => message.id === pressed.id
    )
    if (
      props.active === false ||
      current?.conversation.id !== conversationId ||
      original == null ||
      !actionsFor(original, current).includes('reply')
    )
      return
    editingNow.current = undefined
    setEditing(undefined)
    replyNow.current = original
    setReplyTo(original)
    // Keep trusted mobile-web activation and repeated Reply actions synchronous.
    focusComposer.current()
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
    menu == null || props.active === false
      ? undefined
      : view.messages.find(message => message.id === menu.id)
  const selectedFor = (action: MessageAction): MessageView | undefined => {
    const current = engine.view(conversationId)
    const selected = current?.messages.find(message => message.id === menu?.id)
    if (
      props.active === false ||
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
    if (restoreTarget.current != null) {
      const actual = Math.max(0, contentOffset.y)
      const target = reachableOffset(restoreTarget.current)
      if (Math.abs(actual - target) <= 1) {
        const anchor = scrolled.current.anchor
        rememberPosition(
          actual,
          anchor == null
            ? undefined
            : {
                id: anchor.id,
                relativeY: anchor.relativeY + scrolled.current.offset - actual
              }
        )
      }
      return
    }
    scrolled.current.offset = Math.max(0, contentOffset.y)
    const pending = prepend.current
    if (
      pending != null &&
      latestView.current?.messages[0]?.seq === pending.firstSeq &&
      latestView.current?.hasEarlier === pending.hasEarlier &&
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
  }

  const rememberNativeScroll = (
    event: NativeSyntheticEvent<NativeScrollEvent>,
    end?: 'drag' | 'momentum'
  ): void => {
    if (!mounted.current || !paneActive.current) return
    const input = nativeUserScroll.current
    const owned =
      Platform.OS !== 'web' && input != null && (end == null || end === input)
    // An authoritative user offset must not be discarded as an outstanding
    // programmatic restoration acknowledgement.
    if (owned) restoreTarget.current = undefined
    rememberScroll(event)
    if (owned) userScrolled()
    if (end != null && end === input) nativeUserScroll.current = undefined
    if (end === 'momentum' && input !== 'drag')
      nativeMomentumFromDrag.current = false
  }

  const content = (
    <>
      <ChatViewport viewport={viewport}>
        {props.paneHeader === true && (
          <GlassView
            onLayout={event => {
              setPaneHeaderHeight(event.nativeEvent.layout.height)
            }}
            style={{
              position: 'absolute',
              top: viewport.header,
              left: 0,
              right: 0,
              zIndex: 3,
              minHeight: Math.max(
                theme.rem(3.5),
                theme.rem(2.25) * window.fontScale + theme.rem(0.5)
              ),
              paddingHorizontal: margin,
              paddingVertical: theme.rem(0.25),
              borderBottomWidth: 1,
              borderBottomColor: theme.glassBorderColor
            }}
          >
            <ChatConversationIdentity
              conversation={view.conversation}
              onPress={onMembers}
            />
          </GlassView>
        )}
        {hasPins && props.active !== false && (
          <View
            pointerEvents="box-none"
            testID="chat-pinned-band"
            onLayout={event => {
              setPinHeight(event.nativeEvent.layout.height)
            }}
            style={{
              position: 'absolute',
              top:
                viewport.header +
                (props.paneHeader === true ? paneHeaderHeight : 0),
              left: Math.max(margin, insets.left),
              right: Math.max(margin, insets.right),
              paddingVertical: theme.rem(0.25),
              zIndex: 3
            }}
          >
            <PinnedMessageSummary
              pins={view.pins ?? []}
              messages={view.messages}
              onJump={jumpTo}
              onOpenList={() => {
                setPinsOpen(true)
              }}
            />
          </View>
        )}
        <ScrollView
          testID="chat-message-history"
          ref={scroller}
          style={styles.fill}
          contentContainerStyle={[
            styles.messages,
            {
              paddingTop: viewport.contentTop,
              paddingBottom: viewport.contentBottom,
              paddingLeft: Math.max(margin, insets.left),
              paddingRight: Math.max(margin, insets.right)
            }
          ]}
          keyboardShouldPersistTaps="handled"
          onScroll={event => {
            const { x = 0, y } = event.nativeEvent.contentOffset
            const previous = gestureOffset.current
            // Web motion is observed before RNW throttles notifications. Native
            // packets still cancel on actual motion or uncertain coordinates.
            if (
              Platform.OS !== 'web' &&
              (!Number.isFinite(x) ||
                !Number.isFinite(y) ||
                x !== previous.x ||
                y !== previous.y)
            )
              gestureGeneration.current += 1
            gestureOffset.current = { x, y }
            rememberNativeScroll(event)
          }}
          // A throttled Android stream need not send its last edge offset.
          // End events carry the authoritative settled position.
          onScrollEndDrag={event => {
            rememberNativeScroll(event, 'drag')
          }}
          onMomentumScrollEnd={event => {
            rememberNativeScroll(event, 'momentum')
          }}
          onMomentumScrollBegin={() => {
            if (
              Platform.OS !== 'web' &&
              mounted.current &&
              paneActive.current &&
              nativeMomentumFromDrag.current &&
              nativeUserScroll.current !== 'drag'
            ) {
              nativeUserScroll.current = 'momentum'
              userScrolled()
            }
          }}
          onScrollBeginDrag={() => {
            gestureGeneration.current += 1
            if (
              Platform.OS !== 'web' &&
              mounted.current &&
              paneActive.current
            ) {
              nativeUserScroll.current = 'drag'
              nativeMomentumFromDrag.current = true
              userScrolled()
            }
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
                scrolled.current.content = height
                const target = rememberPosition(
                  Math.max(0, previous.offset + height - previous.content)
                )
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
                      const measured = rememberPosition(
                        Math.max(0, y - anchor.relativeY),
                        anchor
                      )
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
              restoreExhaustedPage()
              previous.content = height
            }
            const held = menuReading.current
            if (held != null) {
              scrolled.current.content = height
              if (held.anchor != null) {
                restoreAnchor.current = held.anchor
                restoreReadingAnchor()
              } else
                scroller.current?.scrollTo({ y: held.offset, animated: false })
              return
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
            else recaptureLiveAnchor()
          }}
        >
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
                if (!mounted.current || !paneActive.current) return
                const y = event.nativeEvent.layout.y
                messagePositions.current.set(message.id, y)
                if (
                  view.messages[0]?.seq === prepend.current?.firstSeq &&
                  view.hasEarlier === prepend.current?.hasEarlier
                )
                  prepend.current?.positions.set(message.id, y)
                if (message.id === prepend.current?.firstId)
                  restoreExhaustedPage()
                if (message.id === restoreAnchor.current?.id)
                  restoreReadingAnchor()
                else recaptureLiveAnchor()
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
                showSenderAvatar={endsIncomingRun(
                  view.messages,
                  index,
                  notices.has(index + 1)
                )}
                onLongPress={(pressed, anchor, source) => {
                  if (actionsFor(pressed, view).length > 0) {
                    const visible = readMessageScrollPosition(
                      scroller.current,
                      messageRefs.current
                    )
                    menuReading.current = {
                      offset: visible?.offset ?? scrolled.current.offset,
                      top: readableTop.current,
                      anchor:
                        visible?.anchor ??
                        readingAnchor(messagePositions.current)
                    }
                    scrolled.current.offset = menuReading.current.offset
                    scrolled.current.anchor = menuReading.current.anchor
                    scrolled.current.hasPosition = true
                    scrolled.current.followNewest = false
                    atBottom.current = false
                    setMenu(pressed)
                    setMenuAnchor(anchor)
                    setMenuSource(source)
                  }
                }}
                onReact={pressed => {
                  setReacting(pressed)
                }}
                onReply={reply}
                onToggleReaction={(pressed, emoji, mine) => {
                  react(pressed, emoji, mine)
                }}
              />
            </View>
          ))}
          {notices.get(view.messages.length)?.map(renderNotice)}
        </ScrollView>
        <View
          testID="chat-composer-band"
          pointerEvents="box-none"
          onLayout={event => {
            setComposerHeight(event.nativeEvent.layout.height)
          }}
          style={{
            position: 'absolute',
            left: Math.max(margin, insets.left),
            right: Math.max(margin, insets.right),
            bottom: viewport.composerBottom,
            zIndex: 4
          }}
        >
          {typing.length > 0 && (
            <Text style={shared.small} accessibilityLiveRegion="polite">
              {typing.length === 1
                ? sprintf(lstrings.chat_typing_one, typing[0])
                : sprintf(lstrings.chat_typing_many, typing.join(', '))}
            </Text>
          )}
          {error != null && <Text style={shared.error}>{error}</Text>}
          {jumpRetry != null && !resolvingJump && (
            <Button
              testID="chat-history-jump-retry"
              label={lstrings.common_retry}
              kind="text"
              onPress={() => {
                jumpTo(jumpRetry)
              }}
            />
          )}
          {resolvingJump && (
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: theme.rem(0.5)
              }}
            >
              <Text style={shared.small} accessibilityLiveRegion="polite">
                {lstrings.common_loading}
              </Text>
              <Button
                testID="chat-history-jump-cancel"
                label={lstrings.chat_cancel}
                kind="text"
                textColor={theme.dangerColor}
                onPress={() => {
                  jumpGeneration.current += 1
                  measuringJump.current = undefined
                  setResolvingJump(false)
                  restoreReadingAnchor()
                }}
              />
            </View>
          )}
          {reported && (
            <Text style={shared.muted} accessibilityLiveRegion="polite">
              {lstrings.chat_reported}
            </Text>
          )}
          {view.composer === 'closed' ? (
            <View style={shared.banner}>
              <Text style={shared.bannerText}>
                {lstrings.chat_closed_notice}
              </Text>
            </View>
          ) : view.composer === 'readOnly' ? (
            <View style={shared.banner}>
              <Text style={shared.bannerText}>{lstrings.chat_read_only}</Text>
            </View>
          ) : (
            <Composer
              registerFocus={registerComposerFocus}
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
              enabled={view.composer === 'enabled' && props.active !== false}
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
                          view.messages.find(
                            message => message.id === replyTo.id
                          )
                        )
                      }
                    : undefined
              }
              onCancelContext={() => {
                if (editing != null) {
                  textNow.current = ''
                  setText('')
                  mentionTokensNow.current = undefined
                  setMentionTokens(undefined)
                }
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
                  async remaining => await files.pickFiles(source, remaining),
                  'picker'
                )
              }}
              onSend={send}
            />
          )}
        </View>
      </ChatViewport>
      {mentionChoosing?.text === text &&
        view.composer === 'enabled' &&
        props.active !== false && (
          <MentionPicker
            members={view.members}
            error={mentionError}
            onSelect={chooseMention}
            onClose={() => {
              setMentionChoosing(undefined)
              setMentionError(undefined)
              focusComposer.current()
            }}
          />
        )}
      {currentMenu != null && (
        <MessageMenu
          message={currentMenu}
          actions={actionsFor(currentMenu, view)}
          desktop={isFinePointer() && menuAnchor != null}
          anchor={menuAnchor}
          source={menuSource}
          selected={
            <MessageBubble
              message={currentMenu}
              conversation={view.conversation}
              members={view.members}
              engine={engine}
              files={files}
              maxWidth={Math.min(
                bubbleWidth,
                menuSource?.bounds.width ?? bubbleWidth
              )}
              swipe={false}
              selected
              pictures={menuSource?.pictures?.()}
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
            setMenuSource(undefined)
          }}
          onReply={() => {
            const selected = selectedFor('reply')
            if (selected == null) return
            reply(selected)
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
          }}
          onMoreEmoji={() => {
            const selected = selectedFor('react')
            if (selected != null) setReacting(selected)
          }}
          onCopy={async () => {
            const selected = selectedFor('copy')
            if (selected == null) throw new Error('Message unavailable')
            await copyChatText(selected.body)
          }}
          onPin={pinned => {
            const selected = selectedFor(pinned ? 'pin' : 'unpin')
            if (selected == null) return
            run(async () => {
              if (engine.pinMessage == null) throw new Error('Pins unavailable')
              await engine.pinMessage(conversationId, selected.id, pinned)
            }, lstrings.chat_pin_failed)
          }}
          onDelete={() => {
            const selected = selectedFor('delete')
            if (selected == null) return
            run(async () => {
              await engine.deleteMessage(conversationId, selected.id)
            })
          }}
          onDeleteForEveryone={() => {
            const selected = selectedFor('deleteForEveryone')
            if (selected == null) return
            run(async () => {
              await engine.moderatorDelete(conversationId, selected.id)
            })
          }}
        />
      )}
      {pinsOpen && hasPins && props.active !== false && (
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
      <View style={[styles.column, { flex: 1 }]}>{content}</View>
    ) : (
      <Screen overlayContent wide scroll={false} contentStyle={styles.column}>
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
  // The full pane owns its measured content clearances.
  column: {
    flex: 1,
    // Centred in a wide window, as every other chat screen is.
    alignSelf: 'stretch',
    minHeight: 0
  },
  fill: {
    flex: 1,
    gap: theme.rem(theme.spaceSmRem)
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
