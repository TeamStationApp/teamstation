import { execFile } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { expect } from 'chai'

import { makeDatabase } from '../../../../src/server/db/database'
import { nodeDatabaseUrl } from '../../../core/dropletStack'
import { defineE2e, type E2eContext } from '../../../core/spec'
import { directorUpload } from '../../../rigs/media/directorUpload'
import {
  apiToken,
  expectSegmentedPrefix,
  highlightStart,
  pictureAdvancingAt,
  seedPlay,
  servedMediaPlaylist,
  signInOnDesktop
} from '../../../rigs/media/recordingSeek'
import { stackHandle, stackSpace } from '../../../rigs/media/stackSpace'

const run = promisify(execFile)

/** Ten minutes of HEVC with sound, keyed every two seconds, as a take is. */
async function programme(dir: string): Promise<string> {
  const file = join(dir, 'programme.mp4')
  await run(
    process.env.TS_FFMPEG ?? 'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=1280x720:rate=30',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000',
      '-t',
      '600',
      '-c:v',
      'libx265',
      '-preset',
      'ultrafast',
      '-x265-params',
      'log-level=none:keyint=60',
      '-tag:v',
      'hvc1',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      file
    ],
    { maxBuffer: 1 << 22 }
  )
  return file
}

/**
 * A recording uploaded as TS Director, TS Distributor and the phone send one
 * lands in the Space as segments, and a tap on a highlight starts the picture
 * within 5 s on a cold cache: one small object per seek, never a range deep
 * inside one huge file.
 */
async function upload(ctx: E2eContext): Promise<void> {
  const handle = stackHandle(ctx)
  const world = await ctx.fixture('streaming')
  const coach = world.accounts.coach
  const api = handle.api
  const token = await apiToken(api, coach)
  const proof: string[] = []
  const say = (line: string): void => {
    proof.push(line)
  }

  const file = await programme(ctx.runDir)
  say(
    `$ POST ${api}/director/uploads (a 10-minute HEVC programme), its parts, /finish`
  )
  const sent = await directorUpload({
    api,
    token,
    gameId: world.ids.game,
    file,
    title: 'Segmented seek programme',
    startAt: new Date(Date.now() - 15 * 60_000),
    log: say
  })

  const space = await stackSpace(handle)
  say(`$ list videos/${sent.videoId}-…/ in the stack's Space`)
  const objects = await expectSegmentedPrefix(space, sent.videoId)
  for (const object of objects) {
    say(
      `${object.key.replace(/-[0-9a-f]{32}\//, '-…/').padEnd(48)} ${object.size}`
    )
  }
  say(`$ GET ${api}/videos/${sent.videoId}/hls/video.m3u8`)
  const playlist = await servedMediaPlaylist(api, token, sent.videoId)
  expect(playlist).does.not.contain('BYTERANGE')
  expect(playlist).does.not.contain('video.mp4')
  for (const line of playlist.split('\n').slice(0, 14)) {
    say(line.replace(/-[0-9a-f]{32}\//, '-…/').replace(/\?.*$/, ''))
  }
  say(
    `… ${playlist.split('\n').filter(l => l.startsWith('http')).length} segment URLs, no BYTERANGE`
  )

  const db = makeDatabase(nodeDatabaseUrl(handle.databaseUrl))
  let early = ''
  let late = ''
  try {
    early = await seedPlay(db, {
      gameId: world.ids.game,
      battingTeamId: world.ids.awayTeam,
      videoId: sent.videoId,
      secondsIn: 450,
      atBatIndex: 0
    })
    late = await seedPlay(db, {
      gameId: world.ids.game,
      battingTeamId: world.ids.awayTeam,
      videoId: sent.videoId,
      secondsIn: 540,
      atBatIndex: 1
    })
  } finally {
    await db.destroy()
  }

  const session = await ctx.browser(
    { width: 1280, height: 800 },
    { h264: true }
  )
  const { m, page } = session
  const recording = await page.record({
    path: ctx.artifact('segmented-seek-after.webm')
  })
  const media: Array<{ url: string; range: string | undefined }> = []
  const cdp = await page.createCDPSession()
  await cdp.send('Network.enable')
  cdp.on('Network.requestWillBeSent', event => {
    if (/\.(m4s|mp4)(\?|$)/.test(event.request.url)) {
      media.push({
        url: event.request.url,
        range: event.request.headers.Range ?? event.request.headers.range
      })
    }
  })
  try {
    await m.openLink({ link: `${ctx.stack.origin}/sign-in` })
    await signInOnDesktop(ctx, m, 'coach')
    await m.openLink({
      link: `${ctx.stack.origin}/games/${world.ids.game}`
    })
    // The game opens on Info until it has been played; its Videos tab is
    // the second "Videos" on screen, after the sidebar's.
    await m.tapOn({ text: 'Videos', index: 1 })
    for (const [eventId, label] of [
      [early, '7:30'],
      [late, '9:00']
    ] as const) {
      const at = await highlightStart(api, token, sent.videoId, eventId)
      await m.tapOn({ id: `game-highlight-${eventId}` })
      const advancing = await pictureAdvancingAt(page, at.startOffsetSec, {
        withinMs: 5000
      })
      say(
        `tap highlight at ${label} (starts ${at.startOffsetSec} s): picture advancing at ${advancing.at.toFixed(2)} s, ${advancing.ms} ms after the tap`
      )
      // Long enough on screen for the recording to show it playing.
      await new Promise(resolve => setTimeout(resolve, 5000))
    }
  } finally {
    await recording.stop()
    await cdp.detach()
  }
  const ranged = media.filter(request => request.range != null)
  say(`media requests: ${media.length}, with a Range header: ${ranged.length}`)
  expect(ranged, 'every media GET is a whole object').deep.equals([])
  writeFileSync(
    ctx.artifact('upload-objects-after.log'),
    `${proof.join('\n')}\n`
  )
}

export default defineE2e({
  id: 'playback/recordings/segmented-seek',
  title:
    'A recording in the Space is segments, and a highlight plays within 5 s on a cold cache',
  kind: 'e2e',
  covers: [
    'src/server/media/ffmpeg.ts',
    'src/server/media/ingestFile.ts',
    'src/server/media/spacesVideo.ts',
    'src/server/routes/directorUploads.ts',
    'src/server/routes/media.ts'
  ],
  stack: 'isolated',
  fixtures: ['streaming'],
  exclusive: false,
  surfaces: { 'web-chromium': { devices: [] } },
  services: ['api', 'web'],
  apps: [],
  secrets: [],
  costUsd: 0,
  minutes: 15,
  guards: [],
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios: { upload }
})
