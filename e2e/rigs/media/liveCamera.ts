/**
 * A live camera on the stack's API, as the apps make one: its stream and
 * video, and the `rtmp://` URL with its key, which goes to the stack's
 * broadcaster alone (`stackMedia(...).broadcast`). It also answers the
 * stack's API as one signed-in person, and puts that person's session on a
 * browser through maestro-d.
 */

export interface LiveCamera {
  streamId: string
  videoId: string
  /** The camera's RTMP URL, key and all: never print it. */
  url: string
}

export interface Answer {
  status: number
  json: unknown
}

/** One call to the stack's API as the holder of `token`. */
export async function ask(
  api: string,
  token: string,
  path: string,
  init: RequestInit = {},
  fetchFn: typeof fetch = fetch
): Promise<Answer> {
  const response = await fetchFn(`${api}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json'
    }
  })
  const text = await response.text()
  return {
    status: response.status,
    json: text === '' ? null : JSON.parse(text)
  }
}

/** A camera for a game (`POST /games/<id>/live-streams`). */
export async function liveCamera(
  api: string,
  token: string,
  gameId: string,
  label: string,
  fetchFn: typeof fetch = fetch
): Promise<LiveCamera> {
  const made = await ask(
    api,
    token,
    `/games/${gameId}/live-streams`,
    { method: 'POST', body: JSON.stringify({ label }) },
    fetchFn
  )
  if (made.status !== 201) throw new Error(`no camera: ${made.status}`)
  const body = made.json as { id: string; videoId: string; url: string }
  return { streamId: body.id, videoId: body.videoId, url: body.url }
}

/** Ends a camera's stream, as its owner does; answers the status. */
export async function endLiveStream(
  api: string,
  token: string,
  gameId: string,
  camera: Pick<LiveCamera, 'streamId'>,
  fetchFn: typeof fetch = fetch
): Promise<number> {
  return (
    await ask(
      api,
      token,
      `/games/${gameId}/live-streams/${camera.streamId}/end`,
      { method: 'POST' },
      fetchFn
    )
  ).status
}

/** What a maestro-d browser needs to be signed in as `token` on `origin`. */
export interface CookieBrowser {
  setCookies: (options: { cookies: unknown[] }) => Promise<unknown>
}

/** Signs a maestro-d browser in with an API session, as the web app keeps one. */
export async function sessionOnBrowser(
  m: CookieBrowser,
  origin: string,
  token: string
): Promise<void> {
  await m.setCookies({
    cookies: [
      {
        name: 'ts_session',
        value: encodeURIComponent(token),
        domain: new URL(origin).hostname,
        path: '/'
      }
    ]
  })
}

/** Waits for `check`, or throws naming `what`. */
export async function until(
  what: string,
  check: () => boolean | Promise<boolean>,
  timeoutMs = 60_000,
  everyMs = 500
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`)
    await pause(everyMs)
  }
}

export async function pause(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, Math.max(0, ms)))
}
