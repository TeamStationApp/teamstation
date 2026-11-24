import { open, stat } from 'node:fs/promises'
import { basename } from 'node:path'

/**
 * Sends a recording to `/director/uploads` the way TS Director, TS
 * Distributor and the phone's upload client do: open it, send each part the
 * server asks for, finish, then wait for it to be taken in. The server
 * answers the finish at once and works behind it; the apps poll for up to
 * 900 s, which is what `finishMs` is held against.
 */
export interface DirectorUpload {
  uploadId: string
  videoId: string
  bytes: number
  parts: number
  /** From the finish's POST to the upload reading `ready`. */
  finishMs: number
}

export async function directorUpload(options: {
  api: string
  token: string
  gameId: string
  file: string
  title: string
  kind?: 'program' | 'angle'
  startAt: Date
  /** How long the finish may take before this gives up, as the apps do. */
  finishLimitMs?: number
  log?: (line: string) => void
}): Promise<DirectorUpload> {
  const { api, token, file } = options
  const log = options.log ?? (() => {})
  const ask = async (
    path: string,
    init: RequestInit = {}
  ): Promise<{ status: number; json: any }> => {
    const response = await fetch(`${api}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        ...(typeof init.body === 'string'
          ? { 'content-type': 'application/json' }
          : { 'content-type': 'application/octet-stream' }),
        ...(init.headers as Record<string, string> | undefined)
      }
    })
    const text = await response.text()
    let json: any = null
    try {
      json = text === '' ? null : JSON.parse(text)
    } catch {
      json = { text }
    }
    return { status: response.status, json }
  }

  const bytes = (await stat(file)).size
  const opened = await ask('/director/uploads', {
    method: 'POST',
    body: JSON.stringify({
      gameId: options.gameId,
      title: options.title,
      kind: options.kind ?? 'program',
      filename: basename(file),
      sizeBytes: bytes,
      startAt: options.startAt.toISOString()
    })
  })
  if (opened.status !== 201) {
    throw new Error(
      `POST /director/uploads answered ${opened.status}: ${JSON.stringify(opened.json)}`
    )
  }
  const { uploadId, partSize, parts } = opened.json as {
    uploadId: string
    partSize: number
    parts: number
  }
  log(`opened ${uploadId}: ${bytes} bytes in ${parts} parts of ${partSize}`)

  const handle = await open(file, 'r')
  try {
    for (let index = 0; index < parts; index++) {
      const length = Math.min(partSize, bytes - index * partSize)
      const part = Buffer.alloc(length)
      await handle.read(part, 0, length, index * partSize)
      const sent = await ask(`/director/uploads/${uploadId}/parts/${index}`, {
        method: 'PUT',
        body: new Uint8Array(part)
      })
      if (sent.status < 200 || sent.status > 299) {
        throw new Error(`part ${index} answered ${sent.status}`)
      }
    }
  } finally {
    await handle.close()
  }

  const limit = options.finishLimitMs ?? 900_000
  const began = Date.now()
  const finished = await ask(`/director/uploads/${uploadId}/finish`, {
    method: 'POST',
    body: '{}'
  })
  if (finished.status !== 202 && finished.status !== 200) {
    throw new Error(`finish answered ${finished.status}`)
  }
  for (;;) {
    const state = (await ask(`/director/uploads/${uploadId}`)).json as {
      state: string
      videoId?: string
      message?: string
    }
    if (state.state === 'ready' && state.videoId != null) {
      const finishMs = Date.now() - began
      log(`ready as ${state.videoId} after ${finishMs} ms`)
      return { uploadId, videoId: state.videoId, bytes, parts, finishMs }
    }
    if (state.state === 'failed') {
      throw new Error(`the upload failed: ${state.message ?? ''}`)
    }
    if (Date.now() - began > limit) {
      throw new Error(
        `not taken in after ${limit} ms (state ${state.state}): the apps would give up`
      )
    }
    await new Promise(resolve => setTimeout(resolve, 2000))
  }
}
