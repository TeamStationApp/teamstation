import type { Page } from '../core/web'

/** The page's own DevTools session, which this only listens on and reads cookies through. */
type CDPSession = Awaited<ReturnType<Page['createCDPSession']>>
/** What this reads of the request a `Network.requestWillBeSent` event carries. */
interface NetworkRequest {
  url: string
  method: string
  headers: Record<string, string>
}

export interface DocumentNetwork {
  wait: (quietMs: number, replayOrigins?: readonly string[]) => Promise<void>
  close: () => Promise<void>
}

/** A scoring tab survives full navigations. Chromium can omit the terminal
 * event for a fetch belonging to the document that navigation discarded.
 *
 * It watches the page target's own session only: requests from
 * out-of-process iframes and workers are not counted. The scoring page has
 * neither. */
export async function watchDocumentNetwork(
  page: Page
): Promise<DocumentNetwork> {
  const session = await page.createCDPSession()
  const open = new Map<
    string,
    {
      frame?: string
      loader: string
      document: boolean
      request: NetworkRequest
      since: number
    }
  >()
  const loaders = new Map<string, { current?: string; incoming?: string }>()
  const retired = new Set<string>()
  let lastActivity = Date.now()

  /** Forgets the open requests `drop` matches and retires their loaders. */
  function dropOpen(
    drop: (read: { frame?: string; loader: string }) => boolean
  ): void {
    for (const [id, read] of open) {
      if (!drop(read)) continue
      if (read.loader !== '') retired.add(read.loader)
      open.delete(id)
      lastActivity = Date.now()
    }
  }

  function retireFrame(frameId: string): void {
    const frame = loaders.get(frameId)
    for (const loader of [frame?.current, frame?.incoming]) {
      if (loader != null && loader !== '') retired.add(loader)
    }
    loaders.delete(frameId)
  }

  function discardLoader(loader: string): void {
    if (loader !== '') retired.add(loader)
    dropOpen(read => read.loader === loader)
  }

  session.on('Network.requestWillBeSent', event => {
    const { requestId, frameId, loaderId, request } = event
    // Chromium can omit the frame ID, even on a late request from a
    // document whose navigation has already discarded it.
    if (retired.has(loaderId)) return
    const frame = frameId == null ? undefined : loaders.get(frameId)
    const document = event.type === 'Document'
    if (document && frameId != null && loaderId !== frame?.current) {
      // A navigation's preloads can start after the document response finishes
      // but before its frame commits. Keep its loader across that interval.
      if (frame?.incoming != null && frame.incoming !== loaderId)
        discardLoader(frame.incoming)
      loaders.set(frameId, { current: frame?.current, incoming: loaderId })
    } else if (
      // A loader the frame never announced is taken for the old document's.
      // A document Chromium activates without a Document request, as from
      // prerender or the back-forward cache, is not counted until it commits.
      frame?.current != null &&
      loaderId !== '' &&
      loaderId !== frame.current &&
      loaderId !== frame.incoming
    )
      return
    lastActivity = Date.now()
    open.set(requestId, {
      frame: frameId,
      loader: loaderId,
      document,
      request,
      since: lastActivity
    })
  })
  for (const event of [
    'Network.loadingFinished',
    'Network.loadingFailed'
  ] as const)
    session.on(event, ({ requestId }) => {
      const read = open.get(requestId)
      if (read == null) return
      if (
        event === 'Network.loadingFailed' &&
        read.document &&
        read.frame != null
      ) {
        const frame = loaders.get(read.frame)
        if (frame?.incoming === read.loader) {
          delete frame.incoming
          discardLoader(read.loader)
        }
      }
      open.delete(requestId)
      lastActivity = Date.now()
    })
  session.on('Page.frameNavigated', ({ frame }) => {
    if (loaders.get(frame.id)?.current === frame.loaderId) return
    if (frame.parentId == null) {
      for (const frameId of loaders.keys()) retireFrame(frameId)
    } else retireFrame(frame.id)
    retired.delete(frame.loaderId)
    loaders.set(frame.id, { current: frame.loaderId })
    lastActivity = Date.now()
    dropOpen(
      read =>
        (frame.parentId == null ||
          frame.id === read.frame ||
          retired.has(read.loader)) &&
        read.loader !== frame.loaderId
    )
  })
  session.on('Page.frameDetached', ({ frameId }) => {
    retireFrame(frameId)
    dropOpen(read => read.frame === frameId || retired.has(read.loader))
  })
  const close = async (): Promise<void> => {
    session.removeAllListeners()
    open.clear()
    loaders.clear()
    retired.clear()
    if (session.detached) return
    try {
      await session.detach()
    } catch (error) {
      // The browser can close between checking the session and detaching it.
      if (!session.detached) throw error
    }
  }
  try {
    await Promise.all([
      session.send('Page.enable'),
      session.send('Network.enable')
    ])
  } catch (error) {
    await close()
    throw error
  }

  return {
    close,
    async wait(
      quietMs: number,
      replayOrigins?: readonly string[]
    ): Promise<void> {
      const started = Date.now()
      const deadline = started + 30000
      for (;;) {
        const now = Date.now()
        const quietLeft = quietMs - (now - Math.max(started, lastActivity))
        if (open.size === 0 && quietLeft <= 0) return
        if (now >= deadline) {
          if (open.size === 0)
            throw new Error(
              `The page never settled; no request is open, but ${quietMs} ms never passed without one (the last ended ${now - lastActivity} ms ago)`
            )
          const busy = await Promise.all(
            [...open.values()].map(
              async ({ request, since }) =>
                await describeRequest(
                  session,
                  request,
                  now - since,
                  replayOrigins
                )
            )
          )
          throw new Error(
            `The page never settled; still open: ${busy.join(', ')}`
          )
        }
        const delay = open.size === 0 ? quietLeft : 100
        await new Promise(resolve =>
          setTimeout(resolve, Math.min(delay, deadline - now))
        )
      }
    }
  }
}

/** The pending request and, for the roster fixture, its independent retry. */
async function describeRequest(
  session: CDPSession,
  request: NetworkRequest,
  age: number,
  replayOrigins?: readonly string[]
): Promise<string> {
  const url = new URL(request.url)
  const detail = `${request.method} ${url.pathname} (${age} ms)`
  // Independently retry only reads of the fixture API, with the
  // original headers confined to that origin.
  if (
    request.method !== 'GET' ||
    replayOrigins?.includes(url.origin) !== true ||
    !url.pathname.startsWith('/api/')
  )
    return detail
  const at = Date.now()
  const retryMs = 10000
  const signal = AbortSignal.timeout(retryMs)
  try {
    // Chromium reports cookies separately from the request
    // headers. Include the fixture session in the independent GET.
    const { cookies } = await session.send(
      'Network.getCookies',
      { urls: [url.href] },
      { timeout: retryMs }
    )
    const headers = new Headers(request.headers)
    if (cookies.length > 0)
      headers.set(
        'cookie',
        cookies.map(({ name, value }) => name + '=' + value).join('; ')
      )
    const response = await fetch(url, {
      headers,
      signal,
      redirect: 'error'
    })
    await response.body?.cancel()
    return `${detail}, retry ${response.status} in ${Date.now() - at} ms`
  } catch {
    return `${detail}, retry failed after ${Date.now() - at} ms`
  }
}
