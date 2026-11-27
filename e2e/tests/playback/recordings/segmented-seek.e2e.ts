import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { expect } from 'chai'

import { BlockedError } from '../../../core/result'
import { defineHarness, type HarnessContext } from '../../../core/spec'
import { directorUpload } from '../../../rigs/media/directorUpload'
import {
  apiToken,
  expectSegmentedPrefix,
  highlightStart,
  pictureAdvancingAt,
  playerState,
  servedMediaPlaylist,
  signInOnDesktop
} from '../../../rigs/media/recordingSeek'
import {
  stackApi,
  stackControl,
  stackMedia
} from '../../../rigs/media/stackSpace'

/**
 * Ten minutes of HEVC with sound, keyed every two seconds, as a take is:
 * encoded on the stack, served by its pages stand-in, and fetched into the
 * run directory, so the upload below sends a file from this machine as the
 * apps do.
 */
async function programme(ctx: HarnessContext): Promise<string> {
  const media = stackMedia(stackControl(ctx))
  const pagesOrigin = ctx.stack.pagesOrigin
  if (pagesOrigin == null) {
    throw new BlockedError('this stack has no pages stand-in')
  }
  const made = await media.programme({
    seconds: 600,
    path: `/segmented-seek-${randomUUID()}/programme.mp4`
  })
  const response = await fetch(`${pagesOrigin.replace(/\/+$/, '')}${made.path}`)
  expect(response.status).equals(200)
  const bytes = Buffer.from(await response.arrayBuffer())
  expect(bytes.byteLength).equals(made.bytes)
  const file = join(ctx.runDir, 'programme.mp4')
  await writeFile(file, bytes)
  return file
}

/**
 * A recording uploaded as TS Director, TS Distributor and the phone send one
 * lands in the Space as segments, and a tap on a highlight starts the picture
 * within 5 s on a cold cache: one small object per seek, never a range deep
 * inside one huge file.
 */
async function upload(ctx: HarnessContext): Promise<void> {
  const media = stackMedia(stackControl(ctx))
  const world = await ctx.fixture('streaming')
  const coach = world.accounts.coach
  const api = stackApi(ctx)
  const token = await apiToken(api, coach)
  const proof: string[] = []
  const say = (line: string): void => {
    proof.push(line)
  }

  const file = await programme(ctx)
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

  say(`$ list videos/${sent.videoId}-…/ in the stack's Space`)
  const objects = await expectSegmentedPrefix(media, sent.videoId)
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

  const early = await media.play({
    gameId: world.ids.game,
    battingTeamId: world.ids.awayTeam,
    videoId: sent.videoId,
    secondsIn: 450,
    atBatIndex: 0
  })
  const late = await media.play({
    gameId: world.ids.game,
    battingTeamId: world.ids.awayTeam,
    videoId: sent.videoId,
    secondsIn: 540,
    atBatIndex: 1
  })

  const session = await ctx.browser(
    { width: 1280, height: 800 },
    { h264: true }
  )
  const { m, page } = session
  await m.startRecording({ path: ctx.artifact('segmented-seek-after.mp4') })
  const requests: Array<{ url: string; range: string | undefined }> = []
  const cdp = await page.createCDPSession()
  await cdp.send('Network.enable')
  cdp.on('Network.requestWillBeSent', event => {
    if (/\.(m4s|mp4)(\?|$)/.test(event.request.url)) {
      requests.push({
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
    await m.stopRecording({ path: ctx.artifact('segmented-seek-after.mp4') })
    await cdp.detach()
  }
  const ranged = requests.filter(request => request.range != null)
  say(
    `media requests: ${requests.length}, with a Range header: ${ranged.length}`
  )
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
async function repackage(ctx: HarnessContext): Promise<void> {
  const media = stackMedia(stackControl(ctx))
  const world = await ctx.fixture('streaming')
  const api = stackApi(ctx)
  const token = await apiToken(api, world.accounts.coach)
  const proof: string[] = []
  const say = (line: string): void => {
    proof.push(line.replace(/[0-9a-f]{32}/g, '…'))
  }

  // A single-file recording on the plain prefix, as every upload before
  // segments was stored, and its row, made on the stack.
  const { videoId } = await media.singleFile({
    videoId: `vid_repack${Date.now().toString(36)}`,
    gameId: world.ids.game,
    title: 'Before segments',
    startAt: new Date(Date.now() - 20 * 60_000).toISOString(),
    seconds: 600
  })
  const play = await media.play({
    gameId: world.ids.game,
    battingTeamId: world.ids.awayTeam,
    videoId,
    secondsIn: 450,
    atBatIndex: 0
  })
  const before = await servedMediaPlaylist(api, token, videoId)
  expect(before).contains('BYTERANGE')
  say(`$ seeded ${videoId} as one video.mp4 under videos/${videoId}/`)

  const { m, page } = await ctx.browser(
    { width: 1280, height: 800 },
    { h264: true }
  )
  await m.startRecording({ path: ctx.artifact('repackage-under-viewer.mp4') })
  try {
    await m.openLink({ link: `${ctx.stack.origin}/sign-in` })
    await signInOnDesktop(ctx, m, 'coach')
    await m.openLink({ link: `${ctx.stack.origin}/games/${world.ids.game}` })
    await m.tapOn({ text: 'Videos', index: 1 })
    const at = await highlightStart(api, token, videoId, play)
    await m.tapOn({ id: `game-highlight-${play}` })
    await pictureAdvancingAt(page, at.startOffsetSec, { withinMs: 15000 })

    const segment = async (args: string): Promise<string> => {
      say(`$ <stack> node lib/server/dev/segmentSpaceVideos.js ${args}`)
      const out = await media.segment(args.split(' '))
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
    const old = (await media.objects(`videos/${videoId}/`))
      .map(entry => entry.key)
      .filter(key => !key.includes('/stills/'))
    expect(old, 'the old prefix holds only stills').deep.equals([])
    await page.reload()
    await m.tapOn({ text: 'Videos', index: 1 })
    await m.tapOn({ id: `game-highlight-${play}` })
    await pictureAdvancingAt(page, at.startOffsetSec, { withinMs: 5000 })
    say(
      'after --delete-old the old prefix holds only stills, and the page still plays'
    )
  } finally {
    await m.stopRecording({
      path: ctx.artifact('repackage-under-viewer.mp4')
    })
  }
  writeFileSync(ctx.artifact('repackage-run.log'), `${proof.join('\n')}\n`)
}

export default defineHarness({
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
  surfaces: {
    'web-chromium': {
      devices: [],
      // It plays the HEVC recording it uploaded.
      browser: { role: 'browser', needs: ['video'], codecs: ['hevc'] }
    }
  },
  services: [],
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
