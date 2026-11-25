import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { expect } from 'chai'

import { eventually } from '../../../core/readback'
import { BlockedError } from '../../../core/result'
import { defineE2e, type E2eContext } from '../../../core/spec'
import {
  acceptLogo,
  acceptReel,
  endLive,
  goLive,
  REEL_MS,
  reelsRead,
  reelWorld,
  scorer
} from '../../../rigs/media/sponsorReelGame'
import { stackHandle } from '../../../rigs/media/stackSpace'

const TV_APP = 'app.teamstation.tv'

/**
 * E10, the Apple TV (#220): the recorded reel game played on the TV in one
 * to four cameras from 3 s before its half-inning reel shows the logo in
 * each camera's upper right and the reel in the landscape reel space, the
 * heard camera's volume falling to 0.2 under it.
 *
 * A person or agent at the remote: the TV is leased on the maestro-d hub and driven by its remote
 * there (`maestro-d pressKey`, `get screenshot`, `assertVisible` against the
 * hub), never through this run's own daemon. The scenario makes the game,
 * writes `tv-reel-game.json` (the game, its cameras and the reel's start,
 * no secrets) for the person or agent at the remote, with the Yankees
 * player's token for the TV's sign-in in the run directory (mode 600), and
 * waits for them to
 * mark each camera count seen with a `tv-seen-<n>` file in the artifacts.
 * `webcam-capture` films the screen meanwhile.
 */
async function logoAndReel(ctx: E2eContext): Promise<void> {
  if (ctx.surface !== 'web-chromium')
    throw new BlockedError(`runs on web-chromium, not ${ctx.surface}`)
  const setup = await reelWorld(ctx)
  try {
    await acceptLogo(ctx, setup)
    await acceptReel(ctx, setup)
    const { cameras, videos } = await goLive(ctx, setup, 60 * 60_000)
    let reelStart = 0
    try {
      await new Promise(resolve => setTimeout(resolve, 30_000))
      await (await scorer(setup)).endHalf()
      reelStart = (await reelsRead(setup, 1, 30_000)).reels[0].startMs
      await new Promise(resolve =>
        setTimeout(
          resolve,
          Math.max(0, reelStart + REEL_MS + 20_000 - Date.now())
        )
      )
    } finally {
      await endLive(setup, cameras)
    }
    const read = await setup.player.gameSponsors(setup.gameId)
    expect(read.logo, 'the TV draws a logo').not.equals(null)
    expect(read.reels).length(1)
    writeFileSync(
      ctx.artifact('tv-reel-game.json'),
      `${JSON.stringify(
        {
          app: TV_APP,
          origin: ctx.stack.origin,
          gameId: setup.gameId,
          cameras: videos,
          reelStart: new Date(reelStart).toISOString(),
          seekFrom: new Date(reelStart - 3000).toISOString()
        },
        null,
        2
      )}\n`
    )
    // For the TV's sign-in approval, which the Yankees player gives: the
    // run directory, mode 600, never the artifacts.
    writeFileSync(
      join(ctx.runDir, 'tv-player.json'),
      JSON.stringify({
        api: stackHandle(ctx).api,
        token: setup.player.token
      }),
      { mode: 0o600 }
    )
    for (const count of [1, 2, 3, 4])
      await eventually(async () => {
        expect(
          existsSync(ctx.artifact(`tv-seen-${count}`)),
          `the reel seen on the TV with ${count} cameras`
        ).equals(true)
      }, 45 * 60_000)
  } finally {
    await setup.db.destroy()
  }
}

export default defineE2e({
  id: 'playback/sponsors/tv',
  title:
    'The Apple TV draws the sponsor logo on every camera and plays the reel in its layout’s space at its placement, the heard camera at 20%',
  kind: 'e2e',
  covers: [
    'src/app/tv/TvPlayer.tsx',
    'src/app/tv/tvLayout.ts',
    'src/app/tv/TransportVideo.tsx',
    'src/app/player/sponsors/**'
  ],
  stack: 'isolated',
  fixtures: ['sponsors'],
  exclusive: false,
  surfaces: {
    // The TV is not this run's device: it is leased and driven on the
    // maestro-d hub by whoever is at its remote, while the run waits.
    'web-chromium': { devices: [] }
  },
  services: ['web'],
  // The TV runs a local build of this branch, installed on the hub.
  apps: [],
  secrets: [],
  costUsd: 0,
  sendsNoMail: true,
  minutes: 30,
  guards: [],
  faults: ['blank-screen', 'hidden-element'],
  manual: false,
  scenarios: {
    'logo-and-reel': logoAndReel
  }
})
