import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { expect } from 'chai'

import { defineHarness, type HarnessContext } from '../../../core/spec'
import { framesText, recordScreen } from '../../../core/video'
import { appLink, openInApp } from '../../../rigs/app/pointAtStack'
import {
  BUILDING,
  DAY_HEADER,
  fullLogLines,
  hierarchyIds,
  hierarchyTexts,
  LOG_LINE,
  phaseTimingsText,
  PREVIEW_OPEN,
  recordedPhaseLines,
  SHORT_SEASON_LINES
} from '../../../rigs/schedule/autoScheduler'
import { SIGNED_OUT } from '../../../rigs/streaming/soakSignIn'

/**
 * The Auto-Scheduler on a phone builds the packed league (the
 * `packed-league` world) at its exact counts with the C++ engine and HiGHS
 * compiled into the app, in the build modal, whose log shows each step:
 * S5 and S6 each 16 of 18, with the causes that really bind, within two
 * minutes. The preview's calendar heads its days like "Mon · Feb · 22". The
 * same build still carries the chat crypto core beside it.
 */

/** The phone's Build to preview, at most. */
const BUILD_LIMIT_MS = 120_000

interface Watched {
  /** From the tap on Build to the first read without the modal. */
  buildToPreviewMs: number
  /** From the tap on Build to the end of the last read with the modal. */
  lastSeenMs: number
  /** The modal's full log, as the last read with it had it. */
  lines: string[]
  /** Each read of the screen: its start and end after Build, and what it saw. */
  reads: Array<{
    startMs: number
    endMs: number
    modal: boolean
    lines: number
  }>
}

/**
 * Reads the build modal on the phone until it closes: its full log, every
 * step's start and end (the box shows only four lines, and a step's line
 * changes in place), with a screenshot once the solver's progress is in it. The
 * phone's driver reads the screen while HiGHS solves on its own thread; a
 * read of the preview's long calendar can time out, so a failed read is
 * tried again, up to four in a row; once the games are placed, one that
 * times out is the preview's.
 */
async function watchBuild(
  ctx: HarnessContext,
  phone: any,
  platform: string,
  tapped: number
): Promise<Watched> {
  const lines: string[] = []
  const reads: Watched['reads'] = []
  let shot = false
  let lastSeen = tapped
  let failures = 0
  const done = (started: number): Watched => ({
    buildToPreviewMs: started - tapped,
    lastSeenMs: lastSeen - tapped,
    lines,
    reads
  })
  for (;;) {
    if (Date.now() - tapped > 300_000)
      throw new Error('The build modal was still open after 5 minutes')
    const started = Date.now()
    let texts: string[]
    let ids: string[]
    try {
      const tree = await phone.hierarchy({
        signal: AbortSignal.timeout(30_000)
      })
      texts = hierarchyTexts(tree)
      ids = hierarchyIds(tree)
      failures = 0
    } catch (error) {
      // Once the games are placed, a read that times out is the preview's
      // long calendar: the modal's own page is small.
      if (lines.some(line => line.includes('Games placed')))
        return done(started)
      failures++
      if (failures >= 4) throw error
      continue
    }
    const read = {
      startMs: started - tapped,
      endMs: Date.now() - tapped,
      modal: texts.includes(BUILDING),
      // The lines the box shows (the full log is an empty view's id).
      lines: texts.filter(text => LOG_LINE.test(text)).length
    }
    reads.push(read)
    if (!read.modal) return done(started)
    lastSeen = Date.now()
    // The full log only grows while the modal is up.
    const full = fullLogLines(ids)
    if (full != null && full.length > lines.length)
      lines.splice(0, lines.length, ...full)
    if (!shot && lines.some(line => line.includes('Found a schedule with'))) {
      await phone.takeScreenshot(ctx.artifact(`${platform}-building.png`))
      shot = true
    }
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
}

/** A build on the phone: what the watcher read, and when Build was tapped. */
interface Built {
  watched: Watched
  tapped: number
}

/** Signs in, builds the packed league and checks the preview. */
async function buildOnPhone(
  ctx: HarnessContext,
  phone: any,
  platform: 'ios' | 'android',
  appId: string
): Promise<Built> {
  const world = await ctx.fixture('packed-league')
  const open = async (path: string): Promise<void> => {
    await openInApp(phone, appId, appLink(path))
  }
  await phone.launchApp({ appId, stopApp: true })
  // Each run seeds its own admin, so a session from an earlier run goes.
  const signedOut: boolean = await phone
    .assertVisible({ text: SIGNED_OUT, timeout: 12_000 })
    .then(() => true)
    .catch(() => false)
  if (!signedOut) {
    await open('account')
    // Below every affiliation, which each earlier run's league adds to.
    await phone.scrollUntilVisible({
      element: { text: 'Sign out' },
      timeout: 180_000,
      maxScrolls: 60,
      speed: 90
    })
    await phone.tapOn({ text: 'Sign out' })
    await phone.assertVisible({ text: SIGNED_OUT, timeout: 15_000 })
  }
  await ctx.signIn('admin', phone)
  await open(`groups/league/${encodeURIComponent(world.ids.league)}/scheduler`)
  await ctx.checkpoint(
    'seasons-chosen',
    {
      expect: ['S1', 'S2', 'S3', 'S4', 'S5', 'S6'].map(name => ({
        text: `Auto-schedule ${name}`,
        timeout: 30_000
      }))
    },
    phone
  )
  await phone.scrollUntilVisible({ element: { text: 'Build schedule' } })
  await phone.tapOn({ text: 'Build schedule' })
  const tapped = Date.now()
  // The modal opens at once and logs the build while HiGHS solves on its
  // own thread.
  await ctx.checkpoint(
    'building',
    { expect: [{ text: BUILDING, timeout: 15_000 }, { text: 'Cancel' }] },
    phone
  )
  const watched = await watchBuild(ctx, phone, platform, tapped)
  console.error(
    `built in ${Math.round(watched.buildToPreviewMs / 1000)} s, ${watched.lines.length} log lines`
  )
  // One team's games: every game of the league is too much for the
  // phone's driver to read in time. The iPhone's times out reading it, so
  // there the chip is tapped where it sits, at the top of the new preview.
  await (platform === 'ios'
    ? phone.tapOn({ point: '47%,43%' })
    : phone.tapOn({ text: `S1 Team 1 ${world.nonce}`, timeout: 60_000 }))
  await phone.scrollUntilVisible({ element: { text: PREVIEW_OPEN } })
  await phone.scrollUntilVisible({ element: { text: SHORT_SEASON_LINES[3] } })
  await phone.takeScreenshot(ctx.artifact(`${platform}-day-headers-after.png`))
  // The calendar below the unmet lines heads its days in English.
  await ctx.checkpoint(
    'day-headers',
    {
      expect: [
        { text: `.*${DAY_HEADER}.*` },
        { text: '.*undefined · .*', absent: true }
      ],
      readBack: async () => {
        expect(watched.lines.length, 'log lines').greaterThan(2)
        expect(
          watched.lines.some(line => line.includes('Found a schedule with')),
          'solver progress logged'
        ).equals(true)
        expect(watched.buildToPreviewMs).lessThanOrEqual(BUILD_LIMIT_MS)
      }
    },
    phone
  )
  // The same lines head the Fairness tab, whose page is small enough to read
  // whole: the Schedule tab's every game is too much for a phone's driver.
  await phone.tapOn({ text: 'Fairness' })
  // Centred, the middle line leaves the two above and the one below on screen.
  await phone.scrollUntilVisible({
    element: {
      text: 'S6: every team gets 16 of the 18 requested regular-season games.'
    },
    direction: 'UP',
    centerElement: true
  })
  await ctx.checkpoint(
    'preview-counts',
    {
      // S1 to S4 get every game they asked for (10, 10, 12 and 14), so only
      // S5 and S6 are short.
      expect: [
        ...SHORT_SEASON_LINES.map(text => ({ text })),
        { text: '.*S[1-4]: every team gets.*', absent: true }
      ]
    },
    phone
  )
  // Chat says this when its native core is missing from the build.
  await open('chat')
  await ctx.checkpoint(
    'chat-core-present',
    {
      expect: [
        { text: '.*Chat is not available in this build.*', absent: true }
      ]
    },
    phone
  )
  return { watched, tapped }
}

/**
 * The packed league built on the phone, with every phase line the build modal
 * shows: its last lines show for under a second before the preview opens,
 * less than one read of the screen apart, so maestro-d records the phone's
 * screen through the build and the lines are read from its frames.
 */
async function packedLeague(
  ctx: HarnessContext,
  platform: 'ios' | 'android'
): Promise<void> {
  const appId = ctx.app(
    platform === 'ios' ? 'teamstation-ios' : 'teamstation-android'
  )
  const phone = await ctx.attach('phone', { platform, appId })
  let built: Built | undefined
  const recording = await recordScreen(
    phone,
    ctx.runDir,
    `${platform}-build`,
    async () => {
      built = await buildOnPhone(ctx, phone, platform, appId)
    }
  )
  if (built == null) throw new Error('The build never finished')
  const video = recording.file
  const scratch = join(ctx.runDir, 'scratch')
  // The driver's tap returns once the screen has settled after it, up to
  // seconds after the modal opened, so the frames are timed from the first
  // with the modal, when its clock starts. The preview's first read can take
  // long after the modal closes: the frames read are those from 12 s before
  // the modal was last seen, timed from its opening (the log's first lines
  // still whole), to the preview.
  const tappedSec = (built.tapped - recording.startedAtMs) / 1000
  const openedSec = recordedPhaseLines(
    framesText(video, scratch, tappedSec - 10, tappedSec + 5),
    BUILDING
  ).firstModalSec
  if (openedSec == null)
    throw new Error('The recording shows no modal around the tap on Build')
  const opened = { sec: openedSec, tapLagSec: tappedSec - openedSec }
  const frames = framesText(
    video,
    scratch,
    openedSec + built.watched.lastSeenMs / 1000 - 12,
    tappedSec + built.watched.buildToPreviewMs / 1000 + 3
  ).map(frame => ({ ...frame, atSec: frame.atSec - openedSec }))
  const { watched } = built
  const recorded = recordedPhaseLines(frames, BUILDING)
  writeFileSync(
    ctx.artifact(`${platform}-phase-timings.log`),
    phaseTimingsText({
      command: `(teamstation-devops) npm run e2e -- run <ts>/e2e/tests/schedule/auto-scheduler/native-solver.e2e.ts --scenario packed-league --surface ${platform}-app`,
      platform: `${platform}-app (${ctx.device('phone').slice(0, 8)}…)`,
      scenario: 'native-solver#packed-league',
      buildToPreviewMs: watched.buildToPreviewMs,
      lines: watched.lines,
      preface:
        platform === 'ios'
          ? [
              '# The modal’s full log below is what the watcher’s last read of the phone’s screen with the modal saw (each read’s times are in the notes), about 2.7 s a read on the iPhone plus 1 s between reads,',
              '# so lines logged in the time after that read, before the modal closes, are missing there. The last lines, “Options polished” and “Options chosen” among them, are read',
              '# from the iPhone’s screen recorded through the build, after the log.'
            ]
          : [],
      appendix: [
        'Read from the screen recording, not from the sampled reads (maestro-d’s startRecording and stopRecording on the phone, from before sign-in until after its last read; its frames from 12 s before the modal was last seen (timed from its opening) to the preview, at 4 frames a second, read with macOS Vision in the video layer; frame times are seconds after the first frame with the modal, when its clock starts):',
        `  The first frame with the modal: ${opened.sec.toFixed(2)} s into the recording (the driver’s tap on Build returned ${opened.tapLagSec.toFixed(1)} s later; the read times in the notes are from that return)`,
        `  The last frame with the modal: ${recorded.lastModalSec?.toFixed(2) ?? 'none'} s`,
        ...recorded.lines.map(
          ({ line, firstSec, frames: count }) =>
            `  ${line}   (first in the frame at ${firstSec.toFixed(2)} s, in ${count} frame${count === 1 ? '' : 's'}${watched.lines.includes(line) ? '' : '; missed by the sampled reads'})`
        )
      ],
      notes: [
        `The modal was last seen ${(watched.lastSeenMs / 1000).toFixed(1)} s after Build; Build to preview is to the start of the first read without it.`,
        `Reads of the screen (start–end s after Build, modal or not, log lines): ${watched.reads
          .map(
            read =>
              `${(read.startMs / 1000).toFixed(1)}–${(read.endMs / 1000).toFixed(1)} ${read.modal ? 'modal' : 'no modal'} ${read.lines}`
          )
          .join('; ')}`
      ]
    })
  )
  for (const phase of ['Options polished', 'Options chosen'])
    expect(
      recorded.lines.some(({ line }) => line.includes(phase)),
      `the recording shows “${phase}”`
    ).equals(true)
}

export default defineHarness({
  id: 'schedule/auto-scheduler/native-solver',
  title:
    'The Auto-Scheduler builds a packed league at its exact counts with the C++ engine compiled into the app, logging the build in its modal',
  kind: 'e2e',
  covers: [
    'src/common/autoScheduler/**',
    'src/common/scheduler/**',
    'src/app/components/ScheduleBuildModal.tsx',
    'src/app/screens/schedulePreviewCalendar.ts',
    'native/scheduler/**',
    'native/highs/**',
    'ios/TeamStation/Scheduler/**',
    'android/app/src/main/jni/**'
  ],
  stack: 'isolated',
  fixtures: ['packed-league'],
  exclusive: false,
  surfaces: {
    'ios-app': {
      devices: [{ role: 'phone', needs: ['ios-phone'], simulator: 'never' }]
    },
    'android-app': {
      devices: [
        { role: 'phone', needs: ['android-phone'], simulator: 'allowed' }
      ]
    }
  },
  services: [],
  apps: ['teamstation-ios', 'teamstation-android'],
  secrets: [],
  costUsd: 0,
  minutes: 15,
  guards: [],
  faults: ['api-500', 'app-crash'],
  manual: false,
  scenarios: {
    'packed-league': async ctx => {
      await packedLeague(ctx, ctx.surface === 'android-app' ? 'android' : 'ios')
    }
  }
})
