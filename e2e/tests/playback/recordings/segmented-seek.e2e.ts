import { execFile } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { expect } from 'chai'

import { makeDatabase } from '../../../../src/server/db/database'
import { remuxToHls } from '../../../../src/server/media/ffmpeg'
import { putObjectFile } from '../../../../src/server/media/images'
import {
  contentTypeFor,
  listSpaceObjects
} from '../../../../src/server/media/spacesVideo'
import { nodeDatabaseUrl } from '../../../core/dropletStack'
import { defineE2e, type E2eContext } from '../../../core/spec'
import { directorUpload } from '../../../rigs/media/directorUpload'
import {
  apiToken,
  expectSegmentedPrefix,
  highlightStart,
  pictureAdvancingAt,
  playerState,
  seedPlay,
  servedMediaPlaylist,
  signInOnDesktop
} from '../../../rigs/media/recordingSeek'
import {
  onStack,
  STACK_APP,
  stackHandle,
  stackSpace
} from '../../../rigs/media/stackSpace'

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

/**
 * A recording still in the Space as one `video.mp4` is repackaged under a
 * viewer who is playing it: the picture goes on through the switch, the next
 * load is segments and seeks to a highlight within 5 s, and once the old
 * objects are deleted the page still plays.
 */
async function repackage(ctx: E2eContext): Promise<void> {
  const handle = stackHandle(ctx)
  const world = await ctx.fixture('streaming')
  const api = handle.api
  const token = await apiToken(api, world.accounts.coach)
  const space = await stackSpace(handle)
  const proof: string[] = []
  const say = (line: string): void => {
    proof.push(line.replace(/[0-9a-f]{32}/g, '…'))
  }

  // A single-file recording on the plain prefix, as every upload before
  // segments was stored, and its row.
  const source = await programme(ctx.runDir)
  const single = join(ctx.runDir, 'single')
  await mkdir(single, { recursive: true })
  await remuxToHls(process.env.TS_FFMPEG ?? 'ffmpeg', {
    input: source,
    outDir: single,
    layout: 'single-file'
  })
  const videoId = `vid_repack${Date.now().toString(36)}`
  for (const name of ['master.m3u8', 'video.m3u8', 'video.mp4'])
    await putObjectFile({
      space,
      key: `videos/${videoId}/${name}`,
      path: join(single, name),
      contentType: contentTypeFor(name)
    })
  const db = makeDatabase(nodeDatabaseUrl(handle.databaseUrl))
  let play = ''
  try {
    await db
      .insertInto('videos')
      .values({
        id: videoId,
        game_id: world.ids.game,
        kind: 'program',
        title: 'Before segments',
        storage: 'spaces',
        status: 'ready',
        start_at: new Date(Date.now() - 20 * 60_000),
        start_at_source: 'manual',
        duration_sec: 600,
        codecs: 'hvc1',
        width: 1280,
        height: 720,
        spaces_verified_at: new Date()
      })
      .execute()
    play = await seedPlay(db, {
      gameId: world.ids.game,
      battingTeamId: world.ids.awayTeam,
      videoId,
      secondsIn: 450,
      atBatIndex: 0
    })
  } finally {
    await db.destroy()
  }
  const before = await servedMediaPlaylist(api, token, videoId)
  expect(before).contains('BYTERANGE')
  say(`$ seeded ${videoId} as one video.mp4 under videos/${videoId}/`)

  const { m, page } = await ctx.browser(
    { width: 1280, height: 800 },
    { h264: true }
  )
  const recording = await page.record({
    path: ctx.artifact('repackage-under-viewer.webm')
  })
  try {
    await m.openLink({ link: `${ctx.stack.origin}/sign-in` })
    await signInOnDesktop(ctx, m, 'coach')
    await m.openLink({ link: `${ctx.stack.origin}/games/${world.ids.game}` })
    await m.tapOn({ text: 'Videos', index: 1 })
    const at = await highlightStart(api, token, videoId, play)
    await m.tapOn({ id: `game-highlight-${play}` })
    await pictureAdvancingAt(page, at.startOffsetSec, { withinMs: 15000 })

    const segment = async (args: string): Promise<string> => {
      const command = `cd ${STACK_APP} && node lib/server/dev/segmentSpaceVideos.js ${args}`
      say(`$ ssh <stack> '${command}'`)
      const out = await onStack(handle, command)
      for (const line of out.trimEnd().split('\n')) say(line)
      return out
    }
    await segment(`--dry-run --video ${videoId}`)
    await segment(`--video ${videoId}`)
    // Playing on through the switch, from the objects it already holds.
    const playing = await playerState(page)
    await new Promise(resolve => setTimeout(resolve, 60_000))
    const later = await playerState(page)
    expect(later!.currentTime - playing!.currentTime).greaterThan(50)
    say(
      `the viewer played on through the switch: ${playing!.currentTime.toFixed(1)} s → ${later!.currentTime.toFixed(1)} s in 60 s`
    )
    expect(await segment(`--video ${videoId}`)).contains('0 repackaged')

    const after = await servedMediaPlaylist(api, token, videoId)
    expect(after).does.not.contain('BYTERANGE')
    expect(after).does.not.contain('video.mp4')
    await page.reload()
    await m.tapOn({ text: 'Videos', index: 1 })
    await m.tapOn({ id: `game-highlight-${play}` })
    const seek = await pictureAdvancingAt(page, at.startOffsetSec, {
      withinMs: 5000
    })
    say(
      `after a reload the playlist is segments; the highlight plays ${seek.ms} ms after the tap`
    )

    await segment(`--delete-old --dry-run --video ${videoId}`)
    await segment(`--delete-old --video ${videoId}`)
    const old = (await listSpaceObjects(space, `videos/${videoId}/`)).filter(
      key => !key.includes('/stills/')
    )
    expect(old, 'the old prefix holds only stills').deep.equals([])
    await page.reload()
    await m.tapOn({ text: 'Videos', index: 1 })
    await m.tapOn({ id: `game-highlight-${play}` })
    await pictureAdvancingAt(page, at.startOffsetSec, { withinMs: 5000 })
    say(
      'after --delete-old the old prefix holds only stills, and the page still plays'
    )
  } finally {
    await recording.stop()
  }
  writeFileSync(ctx.artifact('repackage-run.log'), `${proof.join('\n')}\n`)
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
    'src/server/routes/media.ts',
    'src/server/dev/segmentSpaceVideos.ts',
    'src/server/media/sliceRecording.ts'
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
  scenarios: { upload, repackage }
})
