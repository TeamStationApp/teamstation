import { writeFileSync } from 'node:fs'
import { basename } from 'node:path'

import { expect } from 'chai'

import { BlockedError } from '../../../core/result'
import { defineHarness, type HarnessContext } from '../../../core/spec'
import {
  endLiveStream,
  liveCamera,
  pause,
  until
} from '../../../rigs/media/liveCamera'
import { apiToken } from '../../../rigs/media/recordingSeek'
import {
  stackApi,
  stackControl,
  stackMedia,
  untilBroadcast
} from '../../../rigs/media/stackSpace'

/**
 * E2E-2: the ingest keeps only the newest pieces of a live stream on its
 * disk, across a reconnect, while the Space gets the whole recording.
 *
 * The stack's own live settings decide the tail and the piece length (its
 * `live.localTailSec` and `live.segmentSeconds`, or the server's defaults),
 * so the publish is scaled to them as the legacy run was to its own 20 s:
 * five tails, a 20 s drop of the publisher, two tails more, then the game's
 * camera is ended. The stack's broadcaster publishes into the stack's own
 * ingest; the ingest's disk is read through the stack's `ingest-files`
 * action and the Space through `objects`, never by this machine.
 */
const OUTAGE_SEC = 20
const SAMPLE_MS = 15_000

interface Seen {
  at: number
  seconds: number
  pieces: number
}

async function keepsTheNewestPieces(ctx: HarnessContext): Promise<void> {
  const { LIVE_LOCAL_TAIL_SEC } =
    await import('../../../../src/server/serverConfigSchema')
  const { parseMediaPlaylist } =
    await import('../../../../src/server/media/wallClockScan')
  const { isSegmentName } =
    await import('../../../../src/server/live/originPublish')
  const { videoPrefix } =
    await import('../../../../src/server/media/videoPrefix')
  const control = stackControl(ctx)
  const media = stackMedia(control)
  const api = stackApi(ctx)
  const world = await ctx.fixture('streaming')
  const gameId = world.ids.game
  const token = await apiToken(api, world.accounts.coach)
  const camera = await liveCamera(api, token, gameId, 'Tail')

  const { live } = await media.ingestFiles(camera.videoId)
  const tailSec = Number(live.localTailSec ?? LIVE_LOCAL_TAIL_SEC)
  const segmentSec = Number(live.segmentSeconds ?? 4)
  if (!(tailSec > 0)) {
    throw new BlockedError(
      `the stack's ingest keeps every piece (live.localTailSec ${tailSec}): there is no tail to hold it to`
    )
  }
  const firstSec = 5 * tailSec
  const secondSec = 2 * tailSec

  const secret = await control.sql(
    'SELECT space_secret FROM videos WHERE id = $1',
    [camera.videoId]
  )
  const spaceSecret = (secret.rows[0]?.space_secret ?? null) as string | null
  const remote = videoPrefix({ id: camera.videoId, spaceSecret })

  /** Seconds of pieces on the ingest's disk, apart from each run's first piece. */
  const onDisk = async (): Promise<{
    pieces: string[]
    seconds: number
    oldest?: string
    remote: number
  }> => {
    const files = await media.ingestFiles(camera.videoId)
    const pieces = files.names.filter(isSegmentName).sort()
    const listed = parseMediaPlaylist(files.master).segments
    const runStarts = new Set(
      listed
        .filter((segment, index) => index === 0 || segment.discontinuity)
        .map(segment => segment.uri)
    )
    const seconds = listed
      .filter(s => pieces.includes(s.uri) && !runStarts.has(s.uri))
      .reduce((sum, s) => sum + s.durationSec, 0)
    const held = await media.objects(remote)
    return {
      pieces,
      seconds,
      oldest: pieces[0],
      remote: held.filter(one => isSegmentName(basename(one.key))).length
    }
  }

  const show = await media.broadcast({
    url: camera.url,
    script: 'outage',
    duration: firstSec + OUTAGE_SEC + secondSec,
    outages: [{ at: firstSec, seconds: OUTAGE_SEC }],
    sound: true
  })
  await pause(show.t0 - Date.now())
  const samples: Seen[] = []
  const log: string[] = [
    `tail ${tailSec} s, pieces of ${segmentSec} s; published ${firstSec} s, dropped ${OUTAGE_SEC} s, ${secondSec} s more`
  ]
  const end = show.t0 + (firstSec + OUTAGE_SEC + secondSec) * 1000
  while (Date.now() < end) {
    await pause(Math.min(SAMPLE_MS, end - Date.now()))
    const seen = await onDisk()
    const at = Math.round((Date.now() - show.t0) / 1000)
    samples.push({ at, seconds: seen.seconds, pieces: seen.pieces.length })
    log.push(
      `t=${at} s: ${seen.pieces.length} pieces on disk (${seen.oldest ?? '-'}…), ${seen.seconds.toFixed(1)} s past the run starts, Space ${seen.remote}`
    )
  }
  const published = await untilBroadcast(
    media,
    show.id,
    'the broadcast to end',
    status => status.exit != null,
    { timeoutMs: 120_000 }
  )
  expect(published.exit, 'the broadcaster published every part').equals(0)
  await pause(3000)

  // After the first stretch the disk never holds more than the tail and the
  // piece being written; the playlist, init.mp4 and each run's first piece
  // (which the wall clock scan reads again) stay too. The writer's pieces
  // run a few milliseconds over a piece's length, hence the 1%.
  for (const seen of samples.filter(s => s.at >= tailSec + 20)) {
    expect(seen.seconds, `t=${seen.at} s`).at.most(
      (tailSec + 2 * segmentSec) * 1.01
    )
  }
  expect(samples.at(-1)!.pieces).below(
    Math.ceil((firstSec + secondSec) / segmentSec) / 2
  )

  expect(await endLiveStream(api, token, gameId, camera)).equals(200)
  await until(
    'the recording to be verified in the Space',
    async () =>
      (
        await control.sql(
          'SELECT spaces_verified_at FROM videos WHERE id = $1',
          [camera.videoId]
        )
      ).rows[0]?.spaces_verified_at != null,
    120_000,
    1000
  )

  // The Space's closed playlist, as the API serves it from there.
  const playback = (await (
    await fetch(`${api}/videos/${camera.videoId}/playback`, {
      headers: { authorization: `Bearer ${token}` }
    })
  ).json()) as { url: string }
  const master = await fetch(playback.url)
  expect(master.status).equals(200)
  let served = await master.text()
  let servedFrom = playback.url
  if (!served.includes('#EXTINF')) {
    const variant = served
      .split('\n')
      .find(line => line !== '' && !line.startsWith('#'))!
    servedFrom = new URL(variant, playback.url).toString()
    served = await (await fetch(servedFrom)).text()
  }
  const closed = parseMediaPlaylist(served)
  expect(closed.ended).equals(true)
  const urls = closed.segments.map(s => new URL(s.uri, servedFrom))
  const names = urls.map(url => basename(url.pathname))
  expect(names[0]).equals('seg000000.m4s')
  for (const url of urls) {
    expect(decodeURIComponent(url.pathname), url.pathname).contains(remote)
  }
  const held = new Set(
    (await media.objects(remote))
      .map(one => basename(one.key))
      .filter(isSegmentName)
  )
  for (const name of names) expect(held.has(name), name).equals(true)
  expect(names).deep.equals([...held].sort())
  expect(served.match(/#EXT-X-DISCONTINUITY\n/g)).length(1)

  const stills = (await media.objects(`videos/${camera.videoId}/stills/`))
    .map(one => basename(one.key))
    .filter(name => name.endsWith('.jpg'))
  expect(stills.length).at.least(1)
  const after = await media.ingestFiles(camera.videoId)
  expect(after.names, 'the ingest’s live directory is gone').deep.equals([])
  expect(after.master).equals('')
  const row = (
    await control.sql('SELECT duration_sec, status FROM videos WHERE id = $1', [
      camera.videoId
    ])
  ).rows[0]
  expect(row?.status).equals('ready')
  log.push(
    `closed: ${names.length} pieces in the Space from ${names[0]}, one discontinuity, ${String(row?.duration_sec)} s, poster ${stills[0]}, local directory gone`
  )
  writeFileSync(ctx.artifact('live-tail.log'), `${log.join('\n')}\n`)
}

export default defineHarness({
  id: 'playback/live-tail/newest-pieces',
  title:
    'The ingest keeps only the newest pieces of a live stream on its disk, across a reconnect, and the Space the whole recording',
  kind: 'e2e',
  covers: [
    'src/server/live/controller.ts',
    'src/server/live/originPublish.ts',
    'src/server/live/originPublisher.ts',
    'src/server/live/playlistTail.ts',
    'src/server/live/finishVideo.ts',
    'src/server/ingest/**'
  ],
  stack: 'isolated',
  fixtures: ['streaming'],
  exclusive: false,
  surfaces: {
    // No page plays anything: the scenario reads the stack alone, so the
    // headless browser the surface names is never opened.
    'web-chromium': { devices: [] }
  },
  services: [],
  apps: [],
  secrets: [],
  costUsd: 0,
  minutes: 14,
  guards: [],
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios: { 'keeps-the-newest-pieces': keepsTheNewestPieces }
})
