import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'

import { expect } from 'chai'

import { BlockedError } from '../../../core/result'
import { defineHarness, type HarnessContext } from '../../../core/spec'
import { stackSql } from '../../../rigs/coach/coachApp'
import { stackControl, stackMedia } from '../../../rigs/media/stackSpace'
import { apiOf, seedBoards, sleep } from '../scoreboard-server/boardSockets'

/**
 * The old E4: an upload carries the server-clock offset its app measured
 * from the open to the video, and the video's wall timeline falls back to
 * that start. Director's upload client is played against the stack's API,
 * with a two-second take made on the stack; the rows are read back
 * from the stack's database.
 */

const OFFSET = 1234

async function offsetCarried(ctx: HarnessContext): Promise<void> {
  const boards = await seedBoards(ctx)
  const gameId = boards.games['-10m']
  const token = boards.runner
  const api = apiOf(ctx)
  const lines: string[] = []
  const say = (line: string): void => {
    lines.push(line)
  }
  const ask = async (
    path: string,
    init: RequestInit = {}
  ): Promise<{ status: number; json: any }> => {
    const response = await fetch(`${api}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        ...(init.body instanceof Uint8Array
          ? { 'content-type': 'application/octet-stream' }
          : { 'content-type': 'application/json' })
      }
    })
    const text = await response.text()
    return {
      status: response.status,
      json: text === '' ? null : JSON.parse(text)
    }
  }
  try {
    say("$ GET /time   the server's clock")
    const clock = await fetch(`${api}/time`)
    const now = ((await clock.json()) as { now: number }).now
    expect(clock.status).equals(200)
    expect(
      Math.abs(now - Date.now()),
      `/time answers the server's clock (${now - Date.now()} ms from this machine's)`
    ).lessThan(5000)

    // The take is made on the stack, as the stack holds the pinned FFmpeg,
    // and fetched from its pages stand-in as Director reads its own file.
    const pagesOrigin = ctx.stack.pagesOrigin
    if (pagesOrigin == null) {
      throw new BlockedError('this stack has no pages stand-in')
    }
    const made = await stackMedia(stackControl(ctx)).take({
      seconds: 2,
      path: `/upload-clock-offset-${randomUUID()}/take.mp4`
    })
    const fetched = await fetch(
      `${pagesOrigin.replace(/\/+$/, '')}${made.path}`
    )
    expect(fetched.status).equals(200)
    const take = Buffer.from(await fetched.arrayBuffer())
    expect(take.length).equals(made.bytes)
    const probed = { streams: made.streams, firstDts: made.firstDts }
    say(
      `made a video-only file ${JSON.stringify({ bytes: take.length, ...probed })}`
    )
    expect(
      probed,
      'one video stream, first packet decoding at zero: no pre-roll'
    ).deep.equals({ streams: ['video/h264'], firstDts: 0 })

    // A minute ago, on this machine's clock, which stands in for the iPad's.
    const startedAt = new Date(Date.now() - 60_000)
    const opened = await ask('/director/uploads', {
      method: 'POST',
      body: JSON.stringify({
        gameId,
        title: 'E4 upload clock offset',
        kind: 'program',
        filename: 'take.mp4',
        sizeBytes: take.length,
        startAt: startedAt.toISOString(),
        serverClockOffsetMs: OFFSET
      })
    })
    say(`POST /director/uploads ${opened.status}`)
    expect(opened.status, 'the upload was opened').equals(201)
    const { uploadId, partSize, parts } = opened.json as {
      uploadId: string
      partSize: number
      parts: number
    }
    for (let index = 0; index < parts; index++) {
      const part = take.subarray(index * partSize, (index + 1) * partSize)
      const sent = await ask(`/director/uploads/${uploadId}/parts/${index}`, {
        method: 'PUT',
        body: new Uint8Array(part)
      })
      say(`PUT part ${index} ${sent.status}`)
    }
    const finished = await ask(`/director/uploads/${uploadId}/finish`, {
      method: 'POST'
    })
    say(`POST finish ${finished.status}`)
    let state: { state: string; videoId?: string; message?: string } = {
      state: ''
    }
    for (let tries = 0; tries < 120; tries++) {
      state = (await ask(`/director/uploads/${uploadId}`)).json
      if (state.state === 'ready' || state.state === 'failed') break
      await sleep(500)
    }
    say(`taken in ${JSON.stringify(state)}`)
    expect(
      state.state,
      `the upload was taken in: ${state.message ?? ''}`
    ).equals('ready')
    const videoId = state.videoId!

    const upload = await stackSql(
      ctx,
      'select server_clock_offset_ms from director_uploads where id = $1',
      [uploadId]
    )
    const row = (
      await stackSql(
        ctx,
        `select start_at, start_at_clock_offset_ms, start_at_source, sync_offset_sec
          from videos where id = $1`,
        [videoId]
      )
    ).rows[0] as {
      start_at: string
      start_at_clock_offset_ms: number
      sync_offset_sec: number
    }
    say(`videos row ${JSON.stringify(row)}`)
    expect(
      Number(upload.rows[0]?.server_clock_offset_ms),
      `the upload keeps serverClockOffsetMs ${OFFSET}`
    ).equals(OFFSET)
    expect(
      Date.parse(row.start_at),
      `start_at ${row.start_at} is startAt ${startedAt.toISOString()} + ${(OFFSET / 1000).toFixed(3)} s`
    ).equals(startedAt.getTime() + OFFSET)
    expect(
      Number(row.start_at_clock_offset_ms),
      `start_at_clock_offset_ms is ${OFFSET}`
    ).equals(OFFSET)

    const timeline = await ask(`/videos/${videoId}/wall-timeline`)
    const wall = Date.parse(row.start_at) - Number(row.sync_offset_sec) * 1000
    expect(timeline.status).equals(200)
    expect(
      JSON.stringify(timeline.json.anchors),
      `one anchor, [0, ${wall}] (${new Date(wall).toISOString()})`
    ).equals(JSON.stringify([[0, wall]]))
    expect(
      { source: timeline.json.source, confidence: timeline.json.confidence },
      'source start, confidence clock'
    ).deep.equals({ source: 'start', confidence: 'clock' })
    const after = await ask(`/videos/${videoId}/wall-timeline?afterMs=0`)
    expect(after.status).equals(200)
    expect(
      after.json.anchors,
      'afterMs=0 adds nothing to the start'
    ).deep.equals([])
  } finally {
    writeFileSync(
      ctx.artifact('upload-clock-offset.log'),
      `${lines.join('\n')}\n`
    )
  }
}

export default defineHarness({
  id: 'playback/scoreboard-log/upload-clock-offset',
  title:
    'An upload keeps the server-clock offset its app measured, and its wall timeline starts there',
  kind: 'e2e',
  covers: [
    'src/server/routes/directorUploads.ts',
    'src/server/media/wallTimeline.ts',
    'src/common/wallTimeline.ts'
  ],
  stack: 'isolated',
  fixtures: ['scoreboard-games'],
  exclusive: false,
  surfaces: {
    // The API and the stack's database only: no page is opened.
    'web-chromium': { devices: [], browser: { role: 'browser', needs: [] } }
  },
  services: [],
  apps: [],
  secrets: [],
  costUsd: 0,
  minutes: 2,
  guards: [],
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios: {
    'offset-carried-to-the-video': offsetCarried
  }
})
