import { useCallback, useEffect, useMemo, useReducer } from 'react'

import type { ChatLinkPreview } from '../../common/chatLinkPreview'
import {
  firstPreviewUrl,
  pageMetadata,
  PREVIEW_TIMEOUT,
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
}
type PreviewEngine = Pick<ChatScreenEngine, 'uploadPreviewThumbnail'>
const drafts = new WeakMap<PreviewEngine, Map<string, Draft>>()

export function useChatLinkPreview(
  engine: PreviewEngine,
  conversationId: string,
  editId: string | undefined,
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
  const slot = JSON.stringify([conversationId, editId])
  const url = useMemo(() => firstPreviewUrl(body, origin), [body, origin])
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
    if (draft.dismissed || draft.ready != null) return
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
      const data = pageMetadata(
        await source.readPreviewPage(url, signal),
        url,
        origin
      )
      if (data == null || !live()) return
      const { imageUrl, ...metadata } = data
      if (metadata.title !== '' || metadata.description !== '') {
        draft.ready = metadata
        refresh()
      }
      if (imageUrl == null || engine.uploadPreviewThumbnail == null) return
      const file = await source.previewThumbnail(imageUrl, signal)
      if (file == null || !live()) return
      clearTimeout(deadline)
      const thumbnail = await engine.uploadPreviewThumbnail(
        conversationId,
        file
      )
      if (live()) {
        draft.ready = { ...metadata, thumbnail }
        draft.uploadedAt = Date.now()
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
    preview:
      current?.url === url && current?.dismissed !== true
        ? current?.ready
        : undefined,
    handleDismiss: () => {
      if (current != null) {
        current.controller?.abort()
        current.dismissed = true
        delete current.ready
        refresh()
      }
    },
    discardEdit,
    sent: () => {
      if (current === cache.get(slot)) cache.delete(slot)
    },
    submit(submitted: string): ChatLinkPreview | undefined {
      const draft = cache.get(slot)
      draft?.controller?.abort()
      if (
        draft == null ||
        draft.dismissed ||
        draft.url !== firstPreviewUrl(submitted, origin)
      )
        return
      if (
        draft.ready?.thumbnail != null &&
        Date.now() - (draft.uploadedAt ?? 0) >= 23 * 60 * 60 * 1000
      ) {
        const { url, title, description, siteName } = draft.ready
        return title !== '' || description !== ''
          ? { url, title, description, siteName }
          : undefined
      }
      return draft.ready
    }
  }
}
