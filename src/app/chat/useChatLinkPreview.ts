import { useCallback, useEffect, useMemo, useReducer } from 'react'

import {
  type ChatLinkPreview,
  withoutThumbnail
} from '../../common/chatLinkPreview'
import {
  firstPreviewUrl,
  pageMetadata,
  PREVIEW_TIMEOUT,
  type PreviewMetadata,
  type PreviewOrigins
} from './linkPreview'
import * as previewSource from './previewTransport'
import type { ChatScreenEngine } from './screenEngine'

interface Draft {
  url: string
  dismissed: boolean
  ready?: ChatLinkPreview
  uploadedAt?: number
  controller?: AbortController
  /** The page as read, so an interrupted image step resumes without it. */
  page?: PreviewMetadata
  /** The image step is over: uploaded, absent or refused. */
  settled?: boolean
}
type PreviewEngine = Pick<ChatScreenEngine, 'uploadPreviewThumbnail'>
const drafts = new WeakMap<PreviewEngine, Map<string, Draft>>()

export function useChatLinkPreview(
  engine: PreviewEngine,
  conversationId: string,
  editing: { id: string; preview?: ChatLinkPreview } | undefined,
  body: string,
  active: boolean,
  origin?: PreviewOrigins,
  source: typeof previewSource = previewSource
): {
  preview?: ChatLinkPreview
  handleDismiss: () => void
  submit: (submitted: string) => ChatLinkPreview | undefined
  sent: () => void
  discardEdit: (id: string) => void
} {
  const cache = useMemo(() => {
    let entries = drafts.get(engine)
    if (entries == null) {
      entries = new Map()
      drafts.set(engine, entries)
    }
    return entries
  }, [engine])
  const slot = JSON.stringify([conversationId, editing?.id])
  const kept = editing?.preview
  const url = useMemo(() => firstPreviewUrl(body, origin), [body, origin])
  // An edit keeps its message's card for the same address until the new
  // wording's card is settled, so a save made sooner does not remove it.
  const choose = (
    draft: Draft | undefined,
    target: string | undefined
  ): ChatLinkPreview | undefined => {
    if (target == null) return
    const own = draft?.url === target ? draft : undefined
    if (own?.dismissed === true) return
    if (own?.settled === true) return own.ready
    return (kept?.url === target ? kept : undefined) ?? own?.ready
  }
  const [, refresh] = useReducer((n: number) => n + 1, 0)
  const current = cache.get(slot)
  useEffect(() => {
    if (!active) return
    if (url == null) {
      cache.delete(slot)
      return
    }
    const previous = cache.get(slot)
    const draft: Draft =
      previous?.url === url ? previous : { url, dismissed: false }
    cache.set(slot, draft)
    if (draft.dismissed || draft.settled === true) return
    const controller = new AbortController()
    draft.controller = controller
    const signal = controller.signal
    const live = (): boolean =>
      !signal.aborted && cache.get(slot) === draft && !draft.dismissed
    let deadline: ReturnType<typeof setTimeout> | undefined
    async function load(): Promise<void> {
      if (url == null || !live()) return
      deadline = setTimeout(() => {
        controller.abort()
      }, PREVIEW_TIMEOUT)
      const page =
        draft.page ??
        pageMetadata(await source.readPreviewPage(url, signal), url, origin)
      if (page == null || !live()) return
      draft.page = page
      const { imageUrl, ...metadata } = page
      if (
        draft.ready == null &&
        (metadata.title !== '' || metadata.description !== '')
      ) {
        draft.ready = metadata
        refresh()
      }
      if (imageUrl == null || engine.uploadPreviewThumbnail == null) {
        draft.settled = true
        return
      }
      const file = await source.previewThumbnail(imageUrl, signal)
      if (!live()) return
      if (file == null) {
        draft.settled = true
        return
      }
      clearTimeout(deadline)
      const thumbnail = await engine.uploadPreviewThumbnail(
        conversationId,
        file
      )
      if (live()) {
        draft.ready = { ...metadata, thumbnail }
        draft.uploadedAt = Date.now()
        draft.settled = true
        refresh()
      }
    }
    const debounce = setTimeout(() => {
      load()
        .catch(() => {})
        .finally(() => {
          clearTimeout(deadline)
        })
    }, 400)
    return () => {
      clearTimeout(debounce)
      clearTimeout(deadline)
      controller.abort()
    }
  }, [active, cache, conversationId, engine, origin, slot, source, url])
  const discardEdit = useCallback(
    (id: string) => {
      const key = JSON.stringify([conversationId, id])
      cache.get(key)?.controller?.abort()
      cache.delete(key)
    },
    [cache, conversationId]
  )
  return {
    preview: choose(current, url),
    handleDismiss: () => {
      if (url == null) return
      const draft: Draft =
        current?.url === url ? current : { url, dismissed: false }
      draft.controller?.abort()
      draft.dismissed = true
      delete draft.ready
      cache.set(slot, draft)
      refresh()
    },
    discardEdit,
    sent: () => {
      if (current === cache.get(slot)) cache.delete(slot)
    },
    submit(submitted: string): ChatLinkPreview | undefined {
      const draft = cache.get(slot)
      draft?.controller?.abort()
      const chosen = choose(draft, firstPreviewUrl(submitted, origin))
      if (
        chosen != null &&
        chosen === draft?.ready &&
        chosen.thumbnail != null &&
        Date.now() - (draft.uploadedAt ?? 0) >= 23 * 60 * 60 * 1000
      )
        return withoutThumbnail(chosen)
      return chosen
    }
  }
}
