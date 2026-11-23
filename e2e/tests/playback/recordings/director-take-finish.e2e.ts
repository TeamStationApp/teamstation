import { stat, writeFile } from 'node:fs/promises'

import { expect } from 'chai'

import { makeDatabase } from '../../../../src/server/db/database'
import { nodeDatabaseUrl } from '../../../core/dropletStack'
import { BlockedError } from '../../../core/result'
import { loadSettings } from '../../../core/settings'
import { defineE2e, type E2eContext } from '../../../core/spec'
import { directorUpload } from '../../../rigs/media/directorUpload'
import {
  apiToken,
  expectSegmentedPrefix,
  highlightStart,
  pictureAdvancingAt,
  seedPlay,
  signInOnDesktop
} from '../../../rigs/media/recordingSeek'
import {
  onStack,
  stackHandle,
  stackSpace
} from '../../../rigs/media/stackSpace'

/** The apps' own wait for a finish: `TeamStationClient.finishUpload`. */
const APP_FINISH_LIMIT_MS = 900_000

/**
 * A real TS Director take of at least 3.5 GB, sent as the apps send one, is
 * taken in, segmented, inside the 900 s the apps wait for the finish, and
 * seeks to a highlight within 5 s.
 */
async function realTake(ctx: E2eContext): Promise<void> {
  const take = loadSettings().directorTake
  if (take == null) {
    throw new BlockedError(
      'set directorTake in the local settings to a real take'
    )
  }
  const bytes = (await stat(take)).size
  expect(bytes, 'a take of 3.5 GB or more').greaterThanOrEqual(3.5e9)
  const handle = stackHandle(ctx)
  const world = await ctx.fixture('streaming')
  const api = handle.api
  const token = await apiToken(api, world.accounts.coach)
  // The stack's own size: the finish is the server's work, so its time is
  // only as good as the machine it ran on.
  const hardware = (
    await onStack(
      handle,
      'echo "$(nproc) vCPU, $(free -g | awk \'/Mem:/ {print $2}\') GiB"'
    )
  ).trim()
  const lines: string[] = [
    "$ TS_E2E_H264_CHROME=… npm run -s e2e -- run 'playback/recordings/director-take-finish#real-take' --surface web-chromium --stack " +
      handle.id,
    `# take ${take}, ${bytes} bytes; stack ${handle.id}, droplet ${hardware}`,
    `# POST ${api}/director/uploads, ${bytes} bytes in parts, POST …/finish, poll until ready`
  ]
  const sent = await directorUpload({
    api,
    token,
    gameId: world.ids.game,
    file: take,
    title: 'Director take, timed',
    startAt: new Date(Date.now() - 3 * 3600_000),
    finishLimitMs: APP_FINISH_LIMIT_MS,
    log: line => lines.push(line)
  })
  lines.push(
    `finish took ${(sent.finishMs / 1000).toFixed(1)} s of the apps' ${APP_FINISH_LIMIT_MS / 1000} s`
  )
  expect(sent.finishMs).lessThan(APP_FINISH_LIMIT_MS)

  const objects = await expectSegmentedPrefix(
    await stackSpace(handle),
    sent.videoId
  )
  lines.push(
    `${objects.length} objects under videos/${sent.videoId}-…/, none over 16 MB, no video.mp4`
  )

  const db = makeDatabase(nodeDatabaseUrl(handle.databaseUrl))
  let play = ''
  try {
    play = await seedPlay(db, {
      gameId: world.ids.game,
      battingTeamId: world.ids.awayTeam,
      videoId: sent.videoId,
      secondsIn: 3600,
      atBatIndex: 0
    })
  } finally {
    await db.destroy()
  }
  const at = await highlightStart(api, token, sent.videoId, play)
  const { m, page } = await ctx.browser(
    { width: 1280, height: 800 },
    { h264: true }
  )
  await m.openLink({ link: `${ctx.stack.origin}/sign-in` })
  await signInOnDesktop(ctx, m, 'coach')
  await m.openLink({
    link: `${ctx.stack.origin}/games/${world.ids.game}`
  })
  // The game opens on Info until it has been played; its Videos tab is
  // the second "Videos" on screen, after the sidebar's.
  await m.tapOn({ text: 'Videos', index: 1 })
  await m.tapOn({ id: `game-highlight-${play}` })
  const advancing = await pictureAdvancingAt(page, at.startOffsetSec, {
    withinMs: 5000
  })
  lines.push(
    `tap highlight an hour in (starts ${at.startOffsetSec} s): picture advancing ${advancing.ms} ms after the tap`
  )
  await writeFile(
    ctx.artifact('director-finish-time.log'),
    `${lines.join('\n')}\n`
  )
}

export default defineE2e({
  id: 'playback/recordings/director-take-finish',
  title:
    'A real multi-gigabyte TS Director take is taken in as segments inside the apps’ 900 s',
  kind: 'e2e',
  covers: [
    'src/server/media/ingestFile.ts',
    'src/server/media/spacesVideo.ts',
    'src/server/routes/directorUploads.ts'
  ],
  stack: 'isolated',
  fixtures: ['streaming'],
  exclusive: true,
  surfaces: { 'web-chromium': { devices: [] } },
  services: ['api', 'web'],
  apps: [],
  secrets: [],
  costUsd: 0,
  minutes: 30,
  guards: [],
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios: { 'real-take': realTake }
})
