import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { execFile, execFileSync } from 'node:child_process'
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { lookup } from 'node:dns/promises'
import { inflateSync } from 'node:zlib'

import { NO_OVERRIDES } from '../../../../src2/common/scoreboard'
import {
  override as overrideOver,
  publish as publishOver
} from '../../../../src2/test/scoreboardPublish.e2e'
import { attach, flatten } from '../../../test/maestroD'

/**
 * GS Director against a development seat: the chosen GameStation event
 * covering recordings (D1, D2), the Scoreboard content item (D3–D6), F1's
 * steps 3–4 (a change reaching the preview, a browser and the live HLS) and
 * a regression pass over the overlay and streaming areas the change touched
 * (R1).
 *
 *   node -r sucrase/register mobile/apps/gsDirector/e2e/scoreboardDirector.e2e.ts \
 *     --step <eventRecording|eventStream|placeSample|hiddenWithoutEvent|
 *             liveOnProgramme|clearedOrClosed|fullPass34|regression>
 *
 * Every step runs against the iPad named by the environment, never one named
 * here, on a maestro-d daemon this agent owns. Director is launched with the
 * `synthetic4` source profile unless DIRECTOR_SOURCE_PROFILE names another,
 * and every step stops at once when the preview says "No output source":
 * with nothing on the preview, overlays are not drawn and D3–D6 prove nothing.
 *
 *   MAESTRO_D             the daemon's name, e.g. director-nativeScoreboard
 *   DIRECTOR_DEVICE_UDID  the iPad
 *   SEAT_HOST             the seat's host, e.g. nativescoreboard.gamestation.co
 *   GS_E2E_GAMES          the seeder's ids, comma-separated, in its order:
 *                         −4 h, −10 m, +1 h … +6 h, cancelled
 *   GS_E2E_TOKEN          a bearer token for scoreboard-e2e@gamestation.local
 *   SEAT_SQL              a command that runs its last argument as SQL on the
 *                         seat's database and prints bare rows, e.g.
 *                         "ssh gs psql -d GameStation_nativeScoreboard -tAc"
 *   SEAT_REDIS            a command that runs redis-cli on the seat, e.g.
 *                         "ssh gs redis-cli"
 *   SEAT_REDIS_PREFIX     the seat's key prefix, gs:<database>
 *   SEAT_SIGN_IN_CODE     a command printing the newest sign-in code of the
 *                         e-mail given as its last argument (read from the
 *                         seat service's journal)
 *   SEAT_HLS_FRAME        a command that writes the last frame of the newest
 *                         segment of the seat's newest live HLS to the PNG
 *                         path given as its last argument (8-bit RGB, e.g.
 *                         ffmpeg's -pix_fmt rgb24), and prints last, on its
 *                         own line, that segment's path and its mtime in
 *                         seconds since the epoch: "<segment> <mtime>". For a
 *                         branch seat, set it to `mobile/apps/gsDirector/e2e/
 *                         seatHlsFrame.sh` (SEAT_SSH, SEAT_VIDEOS and
 *                         SEAT_FFMPEG pick the seat). That script runs over
 *                         ssh: in the newest media/work/videos/vid_* of the
 *                         seat, `cat init.mp4 <newest seg*.m4s>` into a file,
 *                         the seat's ffmpeg on it with -pix_fmt rgb24
 *                         -update 1 -f image2 (the last frame), and `stat -c
 *                         %.3Y` of the segment. Required by fullPass34.
 *                         Optional for D5: when set, D5 saves the frames and
 *                         asserts the board is drawn in them; unset, D5 asks
 *                         for a frame to be read by hand.
 *   GS_CHROME_PATH        fullPass34, optional: the Chrome Puppeteer drives,
 *                         when not Puppeteer's own
 *   TIDY_UP_INTERRUPT     optional: an app's bundle id, e.g.
 *                         com.apple.mobilecal, that the tidy-up brings to the
 *                         front before it opens Settings and before it saves,
 *                         as a tapped notification banner would, to show it
 *                         recovers
 *   TIDY_UP_INTERRUPT_AT  optional, with TIDY_UP_INTERRUPT: `mid` brings the
 *                         app to the front in the middle of an action instead:
 *                         after the tap that stops Stream or Record and
 *                         before its slide, and after the tap that opens
 *                         Settings and before the check that it opened; once
 *                         each, so the action fails and its one retry runs
 *   R1_STREAM_URL         R1 only, required there: the RTMP URL R1 types in
 *                         and streams to. It must be a seat's, never
 *                         production's: R1 refuses gamestation.co and
 *                         www.gamestation.co on any port, and port 1936 on the
 *                         production droplet by any name. To get one, claim a
 *                         seeded game on the seat as the e2e runner and use
 *                         the `url` it answers, which is the seat's
 *                         rtmp://<seat host>:1935/live/<key>:
 *                           curl -s -X POST -H "Authorization: Bearer $GS_E2E_TOKEN" \
 *                             https://develop3.gamestation.co/api/v1/director/events/<gameId>/claim
 *
 * Screenshots land in the run's artifact directory. Each observation of the
 * programme is also confirmed with a frame from the bench webcam (the
 * webcam-capture skill) by whoever runs the step; the step prints where.
 *
 * Whatever a step does, and however it ends, it ends the same way: any sheet
 * it left open is closed, Record and Stream are stopped, the event is
 * cleared and Settings saved, and R1's stream URL is put back as it was. So a
 * failed step never leaves the iPad recording, streaming or covering a game.
 * When the maestro-d session itself drops (WebDriverAgent resets, or the
 * daemon dies), the tidy-up opens a fresh session, starting the daemon again
 * if need be, and runs again from the start, up to three times.
 * Interrupted (SIGINT or SIGTERM), or failing outside the step, the script
 * tidies up the same way before it exits. An interrupted step stops first:
 * its next call to the iPad, the seat, the HLS or the webcam throws, and the
 * tidy-up waits for any call of the step's still under way, so the two never
 * drive the iPad at once.
 * When the tidy-up cannot open Settings even after bringing Director back
 * (a sheet it does not know covers the grid), it stops Director, launches it
 * again and starts over, up to twice.
 * Opening, clearing and saving Settings, and each part of that tidy-up, first
 * bring Director back if another app is in front (a notification banner can
 * take a tap and open its app), and when one fails, Director is brought to
 * the front and it is tried once more (while streaming or recording, Director's
 * picture in picture hides another app in front from the hierarchy, so a
 * failure is the only sign); each recovery is logged. Stopping Stream or Record
 * checks that it stopped.
 *
 * D2 picks its own event, so it runs on its own. D5, fullPass34 and D6 need
 * the board D3 placed. D6 closes the −10 m game's scoreboard, so with one
 * seeded group run D2, D5 and fullPass34 before D6.
 */

const RUNNER_EMAIL = 'scoreboard-e2e@gamestation.local'
const APP_ID = 'co.gamestation.director'

type Device = Awaited<ReturnType<typeof attach>>

interface Env {
  daemon: string
  device: string
  host: string
  games: string[]
  token: string
}

function required(key: string): string {
  const value = process.env[key]
  assert(value != null && value !== '', `${key} is required`)
  return value
}

function env(): Env {
  const games = required('GS_E2E_GAMES').split(',')
  assert(games.length === 9, 'GS_E2E_GAMES holds the seeder’s nine ids')
  return {
    daemon: required('MAESTRO_D'),
    device: required('DIRECTOR_DEVICE_UDID'),
    host: required('SEAT_HOST'),
    games,
    token: required('GS_E2E_TOKEN')
  }
}

/** The seeded games by name. */
function game(e: Env, name: '-4h' | '-10m' | '+1h'): string {
  const at = { '-4h': 0, '-10m': 1, '+1h': 2 }[name]
  return e.games[at]
}

// MARK: - Stopping an interrupted step

/**
 * Why the run was interrupted (SIGINT or SIGTERM), once it has been. From
 * then on the step's own calls throw (`stepGuard`), so it stops driving the
 * iPad while the tidy-up runs.
 */
let aborted: string | undefined

/** Holds `true` in the step's own async context, and nothing in the tidy-up's. */
const stepScope = new AsyncLocalStorage<true>()

/** What a step's call throws once the run is interrupted. */
class StepAborted extends Error {}

/**
 * Throws once the run is interrupted, when called from the step (inside
 * `stepScope`); the tidy-up's calls pass. Checked before each of the step's
 * calls to the iPad (`guarded`), the seat, the HLS, the webcam and the
 * scoreboard sockets, and after each, so a call that was under way when the
 * signal came does not let the step act on what it found.
 */
function stepGuard(doing: string): void {
  if (aborted != null && stepScope.getStore() === true) {
    throw new StepAborted(`${aborted}: the step stops at ${doing}`)
  }
}

/** The step's calls to the iPad that have not finished, for the tidy-up to wait for. */
const stepCalls = new Set<Promise<unknown>>()

/**
 * The step's view of the iPad: every method first checks `stepGuard`, and
 * checks it again when its promise settles. The tidy-up uses the device
 * itself, unguarded.
 */
function guarded(m: Device): Device {
  return new Proxy(m, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver)
      if (typeof value !== 'function') return value
      return (...args: unknown[]): unknown => {
        const doing = `maestro-d ${String(prop)}`
        stepGuard(doing)
        const result: unknown = value.apply(target, args)
        if (!(result instanceof Promise)) return result
        stepCalls.add(result)
        const settled = (): void => {
          stepCalls.delete(result)
        }
        result.then(settled, settled)
        return result.then((resolved: unknown) => {
          stepGuard(`after ${doing}`)
          return resolved
        })
      }
    }
  })
}

/**
 * Waits, at most `limitMs`, for the step's calls to the iPad under way when
 * the run was interrupted to finish, so the tidy-up's first look at the iPad
 * is not followed by a tap of the step's (a Stream tap in flight would
 * otherwise start streaming after the tidy-up checked it had stopped).
 */
async function stepCallsSettled(limitMs: number): Promise<void> {
  if (stepCalls.size === 0) return
  console.error(`  waiting for ${stepCalls.size} call(s) of the step to finish`)
  await Promise.race([
    Promise.allSettled([...stepCalls]),
    new Promise(resolve => setTimeout(resolve, limitMs))
  ])
}

const publish = async (
  ...args: Parameters<typeof publishOver>
): ReturnType<typeof publishOver> => {
  stepGuard('a publish')
  const outcome = await publishOver(...args)
  stepGuard('after a publish')
  return outcome
}

const override = async (
  ...args: Parameters<typeof overrideOver>
): ReturnType<typeof overrideOver> => {
  stepGuard('an override')
  const outcome = await overrideOver(...args)
  stepGuard('after an override')
  return outcome
}

/** Runs one of the SEAT_* commands with a last argument, and returns stdout. */
function seat(key: string, ...args: string[]): string {
  stepGuard(key)
  const [command, ...rest] = required(key).split(' ')
  return execFileSync(command, [...rest, ...args], { encoding: 'utf8' }).trim()
}

const sql = (query: string): string => seat('SEAT_SQL', query)

function redis(...args: string[]): string {
  return seat('SEAT_REDIS', ...args)
}

function scoreboardKey(gameId: string): string {
  return `${required('SEAT_REDIS_PREFIX')}:scoreboard:${gameId}`
}

/** Closes a game's scoreboard: its key goes, and its start moves back 3 h. */
function closeScoreboard(gameId: string): void {
  sql(
    `update games set start_at = now() - interval '3 hours' where id = '${gameId}'`
  )
  redis('DEL', scoreboardKey(gameId))
}

const sleep = async (ms: number): Promise<void> => {
  stepGuard('a pause')
  await new Promise(resolve => setTimeout(resolve, ms))
  stepGuard('after a pause')
}

function webcam(label: string): void {
  stepGuard('a webcam check')
  console.log(`  webcam: confirm "${label}" with a bench webcam frame`)
}

// MARK: - Driving the app

/**
 * Launches Director for a test with the harness's `sourceProfile` launch
 * argument: DIRECTOR_SOURCE_PROFILE, or `synthetic4` by default, which gives
 * Director four generated cameras whatever is on the bench, so the preview
 * has a picture for the overlays to be drawn on and a take has frames.
 * Fails straight away when the preview still has no output source.
 */
async function launch(m: Device): Promise<void> {
  const profile = sourceProfile()
  await launchToGrid(m)
  // Sources take a moment to come up after launch.
  const hasSource = await m
    .extendedWaitUntil({ notVisible: { text: 'No output source' }, timeout: 20_000 })
    .then(() => true)
    .catch(() => false)
  if (!hasSource) {
    await m.shot('no-output-source')
    throw new Error(
      `The preview says "No output source" (source profile "${profile}"). ` +
        'Overlays are not drawn without a picture, so nothing this step checks would ' +
        'mean anything. Run with DIRECTOR_SOURCE_PROFILE=synthetic4 (the default) and ' +
        'the cameras’ VIDEO on, or put a camera on the programme.'
    )
  }
}

/** DIRECTOR_SOURCE_PROFILE, or `synthetic4`. */
const sourceProfile = (): string => process.env.DIRECTOR_SOURCE_PROFILE ?? 'synthetic4'

/**
 * Stops Director if it is running, launches it for a test, and taps DONE on
 * its launch Cameras sheet, to the grid.
 */
async function launchToGrid(m: Device): Promise<void> {
  const profile = sourceProfile()
  await m.launchApp({
    appId: APP_ID,
    stopApp: true,
    arguments: {
      uiTest: true,
      debugHUD: false,
      ...(profile !== '' ? { sourceProfile: profile } : {})
    }
  })
  await m.extendedWaitUntil({ visible: { id: 'start-directing' }, timeout: 30_000 })
  await m.tapOn({ id: 'start-directing' })
  await m.extendedWaitUntil({ visible: { id: 'settings-button' }, timeout: 30_000 })
}

/** The name the hierarchy's root carries while Director is the app in front. */
const DIRECTOR_NAME = 'GS Director'

/** The app in front: the name on the hierarchy's root. */
async function frontApp(m: Device): Promise<string | undefined> {
  return flatten(await m.hierarchy()).find(n => n.bounds != null)?.text
}

/**
 * Brings Director back to the front when another app is there, as it was,
 * without restarting it, and says whether it had to. A tap can land on a
 * notification banner that slid in over Director (a Calendar reminder, in QA
 * round 3) and open its app.
 */
async function bringDirectorBack(m: Device, doing: string): Promise<boolean> {
  const front = await frontApp(m)
  if (front == null || front === DIRECTOR_NAME) return false
  console.log(`  ${doing}: ${front} is in front; bringing Director back`)
  await m.launchApp({ appId: APP_ID, stopApp: false })
  await sleep(2_000)
  const now = await frontApp(m)
  assert(now == null || now === DIRECTOR_NAME, `${doing}: Director is back in front (${now ?? ''})`)
  console.log(`  ${doing}: Director is back in front`)
  return true
}

/**
 * Brings Director to the front whether or not another app seems to be there.
 *
 * While Director is streaming or recording it keeps a picture-in-picture
 * window when another app comes to the front, and the hierarchy then still
 * reads as Director's own (the M4 iPad showed Calendar full screen while
 * `frontApp` said GS Director), so `bringDirectorBack` cannot see the
 * interruption. Asking for Director does nothing when it is already there.
 */
async function bringDirectorToFront(m: Device): Promise<void> {
  await m.launchApp({ appId: APP_ID, stopApp: false })
  await sleep(2_000)
}

/**
 * Runs `action` with Director in front: another app in front is sent back
 * first. When `action` fails, most often because another app came to the
 * front during it (which cannot always be seen: `bringDirectorToFront`), or
 * just after Director was brought back (whose first tap can be lost: a Save
 * that did not save, on the M4 iPad), Director is brought to the front and
 * `again` (by default `action` itself) runs once more. A failure the second
 * time is the step's. A failed maestro-d session is not retried here: the
 * tidy-up opens a fresh one (`tidyUpOrReattach`).
 */
async function inDirector(
  m: Device,
  doing: string,
  action: () => Promise<void>,
  again: () => Promise<void> = action
): Promise<void> {
  await bringDirectorBack(m, doing)
  try {
    await action()
  } catch (error) {
    if (isSessionError(error)) throw error
    if (!(await bringDirectorBack(m, doing))) await bringDirectorToFront(m)
    console.log(
      `  ${doing}: failed (${error instanceof Error ? error.message : String(error)}); ` +
        'Director is in front; trying again once'
    )
    await again()
  }
}

/**
 * Opens Settings at its top. Tried again after an interruption, it finds
 * Settings may already be open (a sheet stays up while Director is behind
 * another app) and only brings it back to its top.
 */
async function openSettings(m: Device): Promise<void> {
  const open = async (): Promise<void> => {
    if ((await boundsOf(m, 'settings-save')) != null) {
      await settingsToTop(m)
      return
    }
    await m.tapOn({ id: 'settings-button' })
    await m.extendedWaitUntil({
      visible: { id: 'settings-gamestation-account' },
      timeout: 20_000
    })
  }
  await inDirector(
    m,
    'opening Settings',
    async () => {
      await m.tapOn({ id: 'settings-button' })
      await interruptMidAction(m, 'opening Settings')
      await m.extendedWaitUntil({
        visible: { id: 'settings-gamestation-account' },
        timeout: 20_000
      })
    },
    open
  )
}

/**
 * Saves Settings. Tried again after an interruption, a sheet already gone
 * means the first tap saved it.
 */
async function saveSettings(m: Device): Promise<void> {
  const save = async (): Promise<void> => {
    await m.tapOn({ id: 'settings-save' })
    await m.extendedWaitUntil({ notVisible: { id: 'settings-save' }, timeout: 10_000 })
  }
  await inDirector(m, 'saving Settings', save, async () => {
    if ((await boundsOf(m, 'settings-save')) == null) {
      console.log('  saving Settings: the sheet had already closed, so it was saved')
      return
    }
    await save()
  })
}

async function signIn(m: Device): Promise<void> {
  await m.tapOn({ id: 'settings-gamestation-account' })
  let signedIn = await m
    .assertVisible({ id: 'gamestation-sign-out', timeout: 3_000 })
    .then(() => true)
    .catch(() => false)
  // Signed in as somebody else, the iPad would list that account's games.
  if (signedIn && !JSON.stringify(await m.hierarchy()).includes(RUNNER_EMAIL)) {
    await m.tapOn({ id: 'gamestation-sign-out' })
    await m.extendedWaitUntil({ visible: { id: 'gamestation-email' }, timeout: 10_000 })
    signedIn = false
  }
  if (!signedIn) {
    await m.tapOn({ id: 'gamestation-email' })
    await m.inputText({ text: RUNNER_EMAIL })
    await m.hideKeyboard()
    await m.tapOn({ id: 'gamestation-send-code' })
    await m.extendedWaitUntil({ visible: { id: 'gamestation-code' }, timeout: 30_000 })
    await sleep(3_000)
    await m.tapOn({ id: 'gamestation-code' })
    await m.inputText({ text: seat('SEAT_SIGN_IN_CODE', RUNNER_EMAIL) })
    await m.hideKeyboard()
    await m.tapOn({ id: 'gamestation-submit-code' })
    await m.extendedWaitUntil({ visible: { id: 'gamestation-sign-out' }, timeout: 30_000 })
  }
  await m.tapOn({ id: 'gamestation-sign-in-done' })
}

// MARK: - Moving about Settings

/** Whether an element is on screen now, waiting at most `timeout`. */
async function isVisible(m: Device, id: string, timeout = 1_000): Promise<boolean> {
  return await m
    .assertVisible({ id, timeout })
    .then(() => true)
    .catch(() => false)
}

/** The element's box in screen points, if it is in the hierarchy. */
async function boundsOf(m: Device, id: string): Promise<Box | undefined> {
  return flatten(await m.hierarchy()).find(n => n.id === id && n.bounds != null)?.bounds
}

/**
 * Settings is scrolled by plain swipes down its left margin, never by
 * `scrollUntilVisible`: once the event row has been used that stops moving
 * the sheet at all (QA round 2, finding 9), and a swipe down the middle can
 * land on a slider and drag it. The margin, left of every row, holds nothing
 * a swipe could change.
 */
const MARGIN = '1%'

/** Flings Settings back to its top, where the account row is. */
async function settingsToTop(m: Device): Promise<void> {
  for (let flings = 0; flings < 15; flings++) {
    if (await isVisible(m, 'settings-gamestation-account')) return
    await m.swipe({ start: `${MARGIN}, 30%`, end: `${MARGIN}, 85%`, duration: 250 })
  }
  throw new Error('Settings did not come back to its top after 15 flings')
}

/**
 * Brings `id` into view in Settings: back to the top, then half a screen at a
 * time downwards until it shows, at most `bound` swipes. A row that has only
 * just come into view can still be under the Cancel/Save bar at the foot of
 * the sheet, where a tap lands on the bar, so it is nudged up clear of it.
 */
async function showInSettings(m: Device, id: string, bound = 12): Promise<void> {
  await settingsToTop(m)
  for (let swipes = 0; ; swipes++) {
    if (await isVisible(m, id)) break
    if (swipes === bound) {
      throw new Error(`${id} did not come into view in ${bound} swipes down Settings`)
    }
    await m.swipe({ start: `${MARGIN}, 75%`, end: `${MARGIN}, 25%`, duration: 600 })
  }
  const footer = await boundsOf(m, 'settings-save')
  for (let nudges = 0; nudges < 3; nudges++) {
    const box = await boundsOf(m, id)
    if (footer == null || box == null || box.y + box.height <= footer.y - 8) return
    await m.swipe({ start: `${MARGIN}, 60%`, end: `${MARGIN}, 45%`, duration: 600 })
  }
}

async function clearEvent(m: Device): Promise<void> {
  await inDirector(m, 'clearing the event', async () => {
    // Scrolled down to the templates, the clear button would be off screen
    // and the optional tap would pass without clearing anything.
    await showInSettings(m, 'settings-gamestation-event')
    await m.tapOn({ id: 'settings-gamestation-event-clear', optional: true })
    await m.assertNotVisible({ id: 'settings-gamestation-event-clear' })
  })
}

async function pickEvent(m: Device, gameId: string): Promise<void> {
  // The event row heads Settings, which may be scrolled down to the templates.
  await showInSettings(m, 'settings-gamestation-event')
  await m.tapOn({ id: 'settings-gamestation-event' })
  await m.extendedWaitUntil({
    visible: { id: `event-picker-row-${gameId}` },
    timeout: 20_000
  })
  await m.tapOn({ id: `event-picker-row-${gameId}` })
  await m.extendedWaitUntil({
    visible: { id: 'settings-gamestation-event-clear' },
    timeout: 20_000
  })
}

async function toggleCapture(m: Device, id: 'record-button' | 'stream-button'): Promise<void> {
  await m.tapOn({ id })
}

/** Completes the slide-to-stop popup after Record or Stream was tapped. */
async function slideToStop(m: Device): Promise<void> {
  await m.extendedWaitUntil({ visible: { id: 'slide-to-stop-track' }, timeout: 8_000 })
  await m.swipe({ start: '79%, 12%', end: '96%, 12%', duration: 1_200 })
}

/** Whether Record or Stream is on: its label reads RECORDING or STREAMING. */
async function isOn(m: Device, id: 'record-button' | 'stream-button'): Promise<boolean> {
  const node = flatten(await m.hierarchy()).find(n => n.id === id)
  return /^(RECORDING|STREAMING)$/i.test(node?.text ?? '')
}

async function record(m: Device, seconds: number): Promise<void> {
  await toggleCapture(m, 'record-button')
  await sleep(seconds * 1_000)
  await toggleCapture(m, 'record-button')
  await slideToStop(m)
}

async function openContentEditor(m: Device): Promise<void> {
  // Content Templates sit below the fold of Settings; the button after them
  // brings the whole list into view.
  await showInSettings(m, 'settings-add-content-template')
  // With a long list of templates the first one can be above the top by now.
  for (let swipes = 0; !(await isVisible(m, 'settings-content-template-1')); swipes++) {
    if (swipes === 6) throw new Error('the first content template did not come into view')
    await m.swipe({ start: `${MARGIN}, 40%`, end: `${MARGIN}, 60%`, duration: 600 })
  }
  // Only the active template draws on the programme; editing another one
  // shows its handles over the active one's overlays. Make the first
  // template the active one, so what is placed is what the preview shows.
  await m.tapOn({ id: 'settings-content-template-select-1' })
  await m.tapOn({ id: 'settings-content-template-1' })
  await m.extendedWaitUntil({ visible: { id: 'content-editor-done' }, timeout: 10_000 })
}

async function closeContentEditor(m: Device): Promise<void> {
  await m.tapOn({ id: 'content-editor-done' })
  // Straight after a drag the first tap on Done can land without closing the
  // editor; a second one does.
  const closed = await m
    .extendedWaitUntil({ notVisible: { id: 'content-editor-done' }, timeout: 3_000 })
    .then(() => true)
    .catch(() => false)
  if (closed) return
  console.log('  Done needed a second tap')
  await m.tapOn({ id: 'content-editor-done' })
  await m.extendedWaitUntil({ notVisible: { id: 'content-editor-done' }, timeout: 10_000 })
}

interface Box {
  x: number
  y: number
  width: number
  height: number
}

/** The editor's overlay handles, by id, in screen points. */
async function overlayHandles(m: Device): Promise<Map<string, Box>> {
  const handles = new Map<string, Box>()
  for (const node of flatten(await m.hierarchy())) {
    if (node.id?.startsWith('overlay-handle-') === true && node.bounds != null) {
      handles.set(node.id, node.bounds)
    }
  }
  return handles
}

/** The one handle that is not among `before`: the overlay just added. */
async function addedHandle(m: Device, before: Map<string, Box>): Promise<string> {
  const added = [...(await overlayHandles(m)).keys()].filter(id => !before.has(id))
  assert.equal(added.length, 1, `one overlay was added (${added.join(', ')})`)
  return added[0]
}

// MARK: - Is the board drawn?

/** A decoded PNG: 8-bit RGB or RGBA, not interlaced, as the screenshots are. */
interface Picture {
  width: number
  height: number
  rgb: (x: number, y: number) => [number, number, number]
}

function readPng(file: Buffer): Picture {
  assert.equal(file.readUInt32BE(0), 0x89504e47, 'the screenshot is a PNG')
  let at = 8
  let width = 0
  let height = 0
  let channels = 0
  const data: Buffer[] = []
  while (at < file.length) {
    const length = file.readUInt32BE(at)
    const type = file.toString('latin1', at + 4, at + 8)
    const body = file.subarray(at + 8, at + 8 + length)
    if (type === 'IHDR') {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      assert(
        body[8] === 8 && body[12] === 0 && (body[9] === 2 || body[9] === 6),
        `a PNG of depth ${body[8]}, colour ${body[9]}, interlace ${body[12]} is not read here`
      )
      channels = body[9] === 6 ? 4 : 3
    } else if (type === 'IDAT') data.push(body)
    else if (type === 'IEND') break
    at += 12 + length
  }
  const raw = inflateSync(Buffer.concat(data))
  const stride = width * channels
  const pixels = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const line = y * (stride + 1) + 1
    const out = y * stride
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? pixels[out + i - channels] : 0
      const b = y > 0 ? pixels[out - stride + i] : 0
      const c = i >= channels && y > 0 ? pixels[out - stride + i - channels] : 0
      let value = raw[line + i]
      if (filter === 1) value += a
      else if (filter === 2) value += b
      else if (filter === 3) value += (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      pixels[out + i] = value & 0xff
    }
  }
  return {
    width,
    height,
    rgb: (x, y) => {
      const i = y * stride + x * channels
      return [pixels[i], pixels[i + 1], pixels[i + 2]]
    }
  }
}

/**
 * Which of the board's own colours a pixel is: its neutral greys (#2d2d2d
 * background, #383838 bases, #4d4d4d–#606060 borders), or the away team's
 * blue gradient (#003087 → #3266ad).
 */
function boardColour(r: number, g: number, b: number): 'grey' | 'blue' | 'green' | undefined {
  // The web board's 404 card: opaque forest green (#2B4221) with mint
  // (#93C47D). Under the programme preview's replay buttons (black at 45%,
  // then white at 16%) the forest reads (61, 71, 56), close enough to neutral
  // to pass for grey, so green is asked first. The gold `synthetic4` noise
  // always has more red than green, and the board's greys are neutral.
  if (g >= 40 && g - r >= 6 && g - b >= 8) return 'green'
  const mean = (r + g + b) / 3
  if (Math.max(r, g, b) - Math.min(r, g, b) <= 16 && mean >= 30 && mean <= 110) {
    return 'grey'
  }
  if (b >= 120 && b - r >= 60 && b - g >= 25) return 'blue'
  return undefined
}

interface Tally {
  grey: number
  blue: number
  green: number
}

/** The share of each colour in `box` (screen points) of a screenshot. */
function tally(picture: Picture, scale: number, box: Box): Tally {
  const left = Math.max(0, Math.round(box.x * scale))
  const top = Math.max(0, Math.round(box.y * scale))
  const right = Math.min(picture.width, Math.round((box.x + box.width) * scale))
  const bottom = Math.min(picture.height, Math.round((box.y + box.height) * scale))
  const count = { grey: 0, blue: 0, green: 0, all: 0 }
  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) {
      const colour = boardColour(...picture.rgb(x, y))
      if (colour != null) count[colour]++
      count.all++
    }
  }
  assert(count.all > 0, `${JSON.stringify(box)} covers some of the screenshot`)
  return {
    grey: count.grey / count.all,
    blue: count.blue / count.all,
    green: count.green / count.all
  }
}

const percent = (share: number): string => `${(share * 100).toFixed(1)}%`

/** A screenshot, and how many of its pixels make a screen point. */
async function screenPicture(m: Device): Promise<{ picture: Picture; scale: number }> {
  const screen = flatten(await m.hierarchy()).find(n => n.bounds != null)?.bounds
  assert(screen != null, 'the screen has bounds')
  const picture = readPng(await m.screenshot())
  const scale = picture.width / screen.width
  assert(
    Math.abs(picture.height / screen.height - scale) < 0.05,
    `the screenshot (${picture.width} x ${picture.height}) is the screen ` +
      `(${screen.width} x ${screen.height} pt) the right way up`
  )
  return { picture, scale }
}

/** An editor handle less its 22-point grips and 3 more for the outline. */
function insideHandle(box: Box): Box {
  const inset = 22 + 3
  return {
    x: box.x + inset,
    y: box.y + inset,
    width: box.width - 2 * inset,
    height: box.height - 2 * inset
  }
}

/** The sample board in the editor: 30% grey and 3% blue (see below). */
const drawnInEditor = (t: Tally): boolean => t.grey >= 0.3 && t.blue >= 0.03

/**
 * Asserts the board is drawn under its editor handle, not just the handle.
 *
 * The screenshot is cropped to the overlay's own rect (the handle less its
 * 22-point grips, less 3 more for the selection outline) and each pixel is
 * classed by `boardColour`. The sample board, 1.0's, is 70% neutral grey and
 * 7% away-team blue at its page size B (607 × 247), and QA's iPad shots of
 * the earlier 640 × 176 board in the editor read 56–64% grey and 8–11% blue
 * at both D3 sizes. The editor's placeholder when
 * nothing is composited (the "No output source" run) is near-black #0c0c0c
 * with a white label: at most 1.3% grey and no blue. The `synthetic4`
 * pattern is gold and brown noise: no grey and no blue. So 30% grey and 3%
 * blue together pass only a drawn board, with room for scaling and blending.
 * The home team's gold gradient is not counted: the noise shares its hues.
 */
async function assertBoardDrawn(m: Device, handle: string, label: string): Promise<void> {
  const box = (await overlayHandles(m)).get(handle)
  assert(box != null, `${handle} is on screen`)
  const { picture, scale } = await screenPicture(m)
  const t = tally(picture, scale, insideHandle(box))
  console.log(
    `  ${label}: under ${handle}, ${percent(t.grey)} board grey, ` +
      `${percent(t.blue)} away-team blue`
  )
  assert(
    drawnInEditor(t),
    `${label}: the board is drawn under its handle (${percent(t.grey)} grey of ` +
      `30%, ${percent(t.blue)} blue of 3%)`
  )
}

/** Where the board sits on the programme, each side a share of it. */
interface Placement {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Makes the first content template the active one, as D3 left it with the
 * board placed: only the active template draws on the programme. Settings
 * must be open, and is left open for the caller to save.
 */
async function activateBoardTemplate(m: Device): Promise<void> {
  await openContentEditor(m)
  await closeContentEditor(m)
}

interface SavedOverlay {
  id: string
  kind: string
  url?: string
  originX: number
  originY: number
  width: number
  height: number
}

/**
 * The active template's overlays, from Director's own `overlays.json`,
 * copied off the iPad with devicectl (which takes the same hardware UDID
 * maestro-d does). Read after Settings is saved.
 */
function activeOverlays(e: Env, m: Device): { name: string; overlays: SavedOverlay[] } {
  const file = `${m.artifactDir}/overlays-${Date.now()}.json`
  execFileSync(
    'xcrun',
    [
      'devicectl', 'device', 'copy', 'from',
      '--device', e.device,
      '--domain-type', 'appDataContainer',
      '--domain-identifier', APP_ID,
      '--source', 'Library/Application Support/GSDirector/Overlays/overlays.json',
      '--destination', file
    ],
    { stdio: 'ignore' }
  )
  const saved = JSON.parse(readFileSync(file, 'utf8')) as {
    activeTemplateID: string
    templates: Array<{ id: string; name: string; overlays: SavedOverlay[] }>
  }
  const active = saved.templates.find(t => t.id === saved.activeTemplateID)
  assert(active != null, 'overlays.json names its active template')
  return active
}

/** Where the active template's Scoreboard item is placed, from `overlays.json`. */
function placedBoard(e: Env, m: Device): Placement {
  const active = activeOverlays(e, m)
  const board = active.overlays.find(o => o.kind === 'scoreboard')
  assert(board != null, `the active template "${active.name}" has a Scoreboard item (run placeSample first)`)
  const placement = { x: board.originX, y: board.originY, width: board.width, height: board.height }
  console.log(`  the board is placed at ${JSON.stringify(placement)} of the programme`)
  return placement
}

/**
 * Asserts `overlays.json` holds overlay `handle` where the editor showed it:
 * its rect, as shares of the programme, within 1% of the handle's (less its
 * grips) on the M4 iPad's preview.
 */
function assertSavedAt(overlays: SavedOverlay[], handle: string, box: Box): void {
  const saved = overlays.find(o => o.id === handle.replace(/^overlay-handle-/, ''))
  assert(saved != null, `overlays.json has ${handle}`)
  const shown = overlayRect(box)
  const want = {
    x: (shown.x - PREVIEW.x) / PREVIEW.width,
    y: (shown.y - PREVIEW.y) / PREVIEW.height,
    width: shown.width / PREVIEW.width,
    height: shown.height / PREVIEW.height
  }
  const got = { x: saved.originX, y: saved.originY, width: saved.width, height: saved.height }
  const off = Math.max(
    ...(['x', 'y', 'width', 'height'] as const).map(side => Math.abs(got[side] - want[side]))
  )
  const fixed = (r: Placement): string =>
    `${r.x.toFixed(4)}/${r.y.toFixed(4)}/${r.width.toFixed(4)}/${r.height.toFixed(4)}`
  console.log(`  overlays.json has ${saved.kind} ${fixed(got)}; the editor showed ${fixed(want)}`)
  assert(off <= 0.01, `overlays.json agrees with the editor for ${handle} (off by ${off.toFixed(4)})`)
}

/** Where on the screen the board and its neighbour are read. */
interface ProgrammeSpots {
  board: Box
  beside: Box
  scale: number
}

interface ProgrammeReading {
  board: Tally
  /** The same size of the programme beside it, where no overlay is. */
  beside: Tally
}

/**
 * The colours of the programme preview on the grid where the board is
 * placed, and beside it.
 *
 * The preview is the `output` tile with the 16:9 picture fitted inside it.
 * The board's rect is read 10% in from each side. Its bottom-left place is
 * under the preview's translucent replay buttons, which tint grey whatever is
 * under them, so each reading is compared with the same size of the preview
 * one and a half boards to the right, under the same buttons: the board's
 * greys show as the difference.
 */
async function programmeSpots(m: Device, placement: Placement): Promise<ProgrammeSpots> {
  const tile = await boundsOf(m, 'output')
  assert(tile != null, 'the programme preview is on screen')
  const width = Math.min(tile.width, (tile.height * 16) / 9)
  const height = (width * 9) / 16
  const video = {
    x: tile.x + (tile.width - width) / 2,
    y: tile.y + (tile.height - height) / 2
  }
  const board = {
    x: video.x + (placement.x + placement.width * 0.1) * width,
    y: video.y + (placement.y + placement.height * 0.1) * height,
    width: placement.width * 0.8 * width,
    height: placement.height * 0.8 * height
  }
  const beside = { ...board, x: board.x + placement.width * 1.5 * width }
  const { scale } = await screenPicture(m)
  return { board, beside, scale }
}

/** One reading: a screenshot, and nothing else, so it is quick. */
async function readProgramme(m: Device, spots: ProgrammeSpots): Promise<ProgrammeReading> {
  const picture = readPng(await m.screenshot())
  return {
    board: tally(picture, spots.scale, spots.board),
    beside: tally(picture, spots.scale, spots.beside)
  }
}

/**
 * Drawn: the board's greys stand out from beside it by 15 points or more.
 * Not drawn: by under 5 points, with no more away-team blue than beside it,
 * and no 404 card, whose opaque green would fill the rect.
 */
const PROGRAMME = { drawn: 0.15, absent: 0.05, blue: 0.01, card: 0.2 }

function describeReading(r: ProgrammeReading): string {
  return (
    `grey ${percent(r.board.grey)} (beside ${percent(r.beside.grey)}), ` +
    `blue ${percent(r.board.blue)} (${percent(r.beside.blue)}), ` +
    `green ${percent(r.board.green)} (${percent(r.beside.green)})`
  )
}

const boardShown = (r: ProgrammeReading): boolean =>
  r.board.grey - r.beside.grey >= PROGRAMME.drawn

const boardGone = (r: ProgrammeReading): boolean =>
  r.board.grey - r.beside.grey < PROGRAMME.absent &&
  r.board.blue - r.beside.blue < PROGRAMME.blue &&
  r.board.green - r.beside.green < PROGRAMME.card

/**
 * Reads the programme preview until `want` holds or `within` has passed, and
 * fails with the last reading; with `within` 0, one reading decides.
 */
async function awaitProgramme(
  m: Device,
  spots: ProgrammeSpots,
  want: 'drawn' | 'absent',
  within: number,
  label: string
): Promise<ProgrammeReading> {
  const test = want === 'drawn' ? boardShown : boardGone
  const started = Date.now()
  for (;;) {
    const reading = await readProgramme(m, spots)
    // Timed from when the screenshot is back, so a pass is never early.
    const elapsed = Date.now() - started
    const passed = test(reading) && (within === 0 || elapsed <= within)
    if (passed || elapsed >= within) {
      console.log(
        `  ${label}: ${describeReading(reading)}, read ${(elapsed / 1_000).toFixed(1)} s in`
      )
      assert(
        passed,
        `${label}: the board is ${want === 'drawn' ? 'drawn' : 'not drawn'} on the ` +
          `programme within ${within / 1_000} s (${describeReading(reading)})`
      )
      return reading
    }
  }
}

// MARK: - Does the board show something new?

/** A share to two decimals: the changes here are fractions of a percent. */
const fine = (share: number): string => `${(share * 100).toFixed(2)}%`

/** The brightness of each pixel of `box` (screen points) of a picture. */
interface Crop {
  luma: Uint8Array
}

function crop(picture: Picture, scale: number, box: Box): Crop {
  const left = Math.max(0, Math.round(box.x * scale))
  const top = Math.max(0, Math.round(box.y * scale))
  const right = Math.min(picture.width, Math.round((box.x + box.width) * scale))
  const bottom = Math.min(picture.height, Math.round((box.y + box.height) * scale))
  const luma = new Uint8Array(Math.max(0, right - left) * Math.max(0, bottom - top))
  let at = 0
  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) {
      const [r, g, b] = picture.rgb(x, y)
      luma[at++] = Math.round(0.299 * r + 0.587 * g + 0.114 * b)
    }
  }
  assert(luma.length > 0, `${JSON.stringify(box)} covers some of the picture`)
  return { luma }
}

/** The share of two crops' pixels whose brightness differs by more than `step`. */
function changedShare(a: Crop, b: Crop, step: number): number {
  assert.equal(a.luma.length, b.luma.length, 'the two crops are the same size')
  let changed = 0
  for (let i = 0; i < a.luma.length; i++) {
    if (Math.abs(a.luma[i] - b.luma[i]) > step) changed++
  }
  return changed / a.luma.length
}

/**
 * How much of the board's crop must change for it to show something new.
 *
 * The board is read where `programmeSpots` and `frameSpots` read it, 10% in
 * from each side, so the moving camera picture around it is left out.
 *
 * - The preview: screenshots are lossless, and QA round 4's four pairs of
 *   shots of an unchanged board differed in no pixel at all, while one count
 *   digit changing moved 0.3–0.6% of the crop by more than 24 levels. So
 *   0.2% by more than 24.
 * - The live HLS: each frame is re-encoded, and the camera noise around the
 *   board smears into it, so an unchanged board differs between segments:
 *   0.3–1.2% of its crop by more than 64 levels on the M4 iPad's stream, but
 *   at most 0.05% by more than 128 (six pairs of unchanged frames). A
 *   digit's white on the board's dark grey moves more: 0.09% for the
 *   subtlest change seen, 1-1 to 2-1 (the 1 and the 2 share most of their
 *   strokes at 1920 wide), and 0.13–0.49% for the others (QA round 4's and
 *   the primary's F1 and D5 frames). So 0.07% by more than 128, and twice
 *   what two frames of the unchanged board moved (`noise`, measured before
 *   the changes).
 */
const CHANGED = {
  preview: { step: 24, share: 0.002 },
  hls: { step: 128, share: 0.0007 }
}

/** Whether `after` shows something `before` did not, given the noise between two of `before`. */
function changedFrom(
  kind: keyof typeof CHANGED,
  before: Crop,
  after: Crop,
  noise = 0
): { share: number; changed: boolean } {
  const share = changedShare(before, after, CHANGED[kind].step)
  return { share, changed: share >= Math.max(CHANGED[kind].share, 2 * noise) }
}

/** The board's crop on the programme preview. */
async function previewCrop(m: Device, spots: ProgrammeSpots): Promise<Crop> {
  return crop(readPng(await m.screenshot()), spots.scale, spots.board)
}

/** The board's crop in a frame of the live HLS. */
function hlsCrop(frame: HlsFrame, placement: Placement): Crop {
  const picture = readPng(readFileSync(frame.path))
  return crop(picture, 1, frameSpots(picture, placement).board)
}

/**
 * Two crops of the board as the preview shows it now, before a change: the
 * one to compare with, and the share of pixels that moved between them, so a
 * board that is not still is not mistaken for a changed one.
 */
async function previewBefore(
  m: Device,
  spots: ProgrammeSpots
): Promise<{ crop: Crop; noise: number }> {
  const first = await previewCrop(m, spots)
  const second = await previewCrop(m, spots)
  return { crop: second, noise: changedShare(first, second, CHANGED.preview.step) }
}

/**
 * Reads the programme preview until the board is drawn and its crop differs
 * from `before`: the new state, not merely a board. Fails after `within` ms.
 * Returns the time to the first differing crop, from `since`, as the
 * screenshot that showed it came back (so never early), and the time the
 * screenshot before it came back (so the change landed in between).
 */
async function awaitPreviewChange(
  m: Device,
  spots: ProgrammeSpots,
  before: { crop: Crop; noise: number },
  since: number,
  within: number,
  label: string
): Promise<{ at: number; after: number; png: Buffer }> {
  let previous = 0
  for (;;) {
    const png = await m.screenshot()
    const at = Date.now() - since
    const picture = readPng(png)
    const reading = {
      board: tally(picture, spots.scale, spots.board),
      beside: tally(picture, spots.scale, spots.beside)
    }
    const { share, changed } = changedFrom(
      'preview',
      before.crop,
      crop(picture, spots.scale, spots.board),
      before.noise
    )
    const passed = changed && boardShown(reading) && at <= within
    if (passed || at >= within) {
      console.log(
        `  ${label} (sent ${new Date(since).toISOString()}): ` +
          `${passed ? 'changed' : 'unchanged'} on the preview ` +
          `${previous}–${at} ms after the send (${fine(share)} of the board moved; ` +
          `${fine(before.noise)} between two shots before), ${describeReading(reading)}`
      )
      assert(
        passed,
        `${label}: the preview shows the new state within ${within / 1_000} s ` +
          `(${fine(share)} of the board moved, of ${fine(CHANGED.preview.share)}; ` +
          `${describeReading(reading)})`
      )
      return { at, after: previous, png }
    }
    previous = at
  }
}

/** Drags from one point to another, both in screen points. */
async function drag(
  m: Device,
  from: { x: number; y: number },
  to: { x: number; y: number }
): Promise<void> {
  const screen = flatten(await m.hierarchy()).find(n => n.bounds != null)?.bounds
  assert(screen != null, 'the screen has bounds')
  const pct = (p: { x: number; y: number }): string =>
    `${Math.round((p.x / screen.width) * 1000) / 10}%, ${Math.round((p.y / screen.height) * 1000) / 10}%`
  // Quick: an overlay held still for 0.55 s opens its edit sheet instead.
  await m.swipe({ start: pct(from), end: pct(to), duration: 400 })
}

/**
 * Sizes an overlay to `width` points by dragging its bottom-right corner,
 * then moves it so its centre lands where `centre` puts an overlay of its
 * new size. A handle's box reaches 22
 * points past the overlay on every side, where the corner grips are centred.
 *
 * The preview is 16:9 and fills the height between the editor's bars: on the
 * M4 iPad (1210 x 834 points) it spans x 92–1118 and y 138–715.
 */
const PREVIEW = { x: 92, y: 138, width: 1026, height: 577 }

/** The centre that puts a `w` x `h` overlay `inset` points inside the preview's bottom-left. */
function bottomLeft(inset: number): (w: number, h: number) => { x: number; y: number } {
  return (w, h) => ({
    x: PREVIEW.x + inset + w / 2,
    y: PREVIEW.y + PREVIEW.height - inset - h / 2
  })
}

/** The centre that puts a `w` x `h` overlay `inset` points inside the preview's right edge, at `down` of its height. */
function rightAt(inset: number, down: number): (w: number, h: number) => { x: number; y: number } {
  return w => ({
    x: PREVIEW.x + PREVIEW.width - inset - w / 2,
    y: PREVIEW.y + PREVIEW.height * down
  })
}

/** The centre that puts a `w` x `h` overlay `inset` points inside the preview's left edge, at `down` of its height. */
function leftAt(inset: number, down: number): (w: number, h: number) => { x: number; y: number } {
  return w => ({
    x: PREVIEW.x + inset + w / 2,
    y: PREVIEW.y + PREVIEW.height * down
  })
}

/** The centre that puts a `w` x `h` overlay `inset` points above the middle of the preview's bottom edge. */
function bottomMiddle(inset: number): (w: number, h: number) => { x: number; y: number } {
  return (w, h) => ({
    x: PREVIEW.x + PREVIEW.width / 2,
    y: PREVIEW.y + PREVIEW.height - inset - h / 2
  })
}

const GRIP = 22

/** An editor handle less its grips: the overlay's own rect. */
function overlayRect(handle: Box): Box {
  return {
    x: handle.x + GRIP,
    y: handle.y + GRIP,
    width: handle.width - 2 * GRIP,
    height: handle.height - 2 * GRIP
  }
}

const centreOf = (box: Box): { x: number; y: number } => ({
  x: box.x + box.width / 2,
  y: box.y + box.height / 2
})

/** How far apart two boxes' centres are, in points. */
function distance(a: Box, b: Box): number {
  const [p, q] = [centreOf(a), centreOf(b)]
  return Math.hypot(p.x - q.x, p.y - q.y)
}

/** The handle of `id` now, which must be on screen. */
async function handleBox(m: Device, id: string): Promise<Box> {
  const box = (await overlayHandles(m)).get(id)
  assert(box != null, `${id} is on screen`)
  return box
}

/**
 * Sizes an overlay to `width` points by dragging its bottom-right corner
 * grip, keeping its aspect. Returns the new handle.
 */
async function resizeOverlay(m: Device, handle: string, width: number): Promise<Box> {
  const box = await handleBox(m, handle)
  const shown = overlayRect(box)
  const aspect = shown.width / Math.max(shown.height, 1)
  const corner = { x: box.x + box.width - GRIP, y: box.y + box.height - GRIP }
  const grow = width - shown.width
  await drag(m, corner, { x: corner.x + grow, y: corner.y + grow / aspect })
  await sleep(1_000)
  return await handleBox(m, handle)
}

/**
 * Drags an overlay by its middle so its centre lands where `centre` puts an
 * overlay of its size, and asserts it went: its centre is at least 50 points
 * from where it was. Returns the new handle.
 */
async function moveOverlay(
  m: Device,
  handle: string,
  centre: (w: number, h: number) => { x: number; y: number }
): Promise<Box> {
  const box = await handleBox(m, handle)
  const shown = overlayRect(box)
  await drag(m, centreOf(box), centre(shown.width, shown.height))
  await sleep(1_000)
  const moved = await handleBox(m, handle)
  const by = distance(box, moved)
  assert(by >= 50, `${handle} moved at least 50 pt (${by.toFixed(0)} pt)`)
  return moved
}

async function placeOverlay(
  m: Device,
  handle: string,
  width: number,
  centre: (w: number, h: number) => { x: number; y: number }
): Promise<Box> {
  const box = await handleBox(m, handle)
  const sized = await resizeOverlay(m, handle, width)
  const w = sized.width - 2 * GRIP
  const h = sized.height - 2 * GRIP
  await drag(m, centreOf(sized), centre(w, h))
  await sleep(1_000)
  const placed = await handleBox(m, handle)
  console.log(
    `  ${handle}: ${JSON.stringify(box)} -> sized ${JSON.stringify(sized)} -> placed ${JSON.stringify(placed)}`
  )
  return placed
}

/** Whether two handles are the same to within `points` on every side. */
const sameBox = (a: Box | undefined, b: Box, points = 1): boolean =>
  a != null &&
  Math.abs(a.x - b.x) <= points &&
  Math.abs(a.y - b.y) <= points &&
  Math.abs(a.width - b.width) <= points &&
  Math.abs(a.height - b.height) <= points

/**
 * The content list's rows, by number. Each row's identifier reaches every
 * control in it, so its toggles and Edit button are found by their labels
 * inside the row rather than by their own identifiers.
 */
async function listRows(m: Device): Promise<Map<number, Array<{ text: string; box: Box }>>> {
  const rows = new Map<number, Array<{ text: string; box: Box }>>()
  for (const node of flatten(await m.hierarchy())) {
    const at = /^content-list-row-(\d+)$/.exec(node.id ?? '')
    if (at == null || node.bounds == null) continue
    const n = Number(at[1])
    rows.set(n, [...(rows.get(n) ?? []), { text: node.text ?? '', box: node.bounds }])
  }
  return rows
}

/** The 1-based row of the content list whose title satisfies `match`. */
async function listRow(m: Device, match: (title: string) => boolean): Promise<number> {
  for (const [n, parts] of await listRows(m)) {
    if (parts.some(part => match(part.text))) return n
  }
  throw new Error('the content list shows the overlay')
}

/** Taps the control labelled `label` in row `n` of the content list. */
async function tapInRow(m: Device, n: number, label: string): Promise<void> {
  const part = (await listRows(m)).get(n)?.find(p => p.text === label)
  assert(part != null, `row ${n} has "${label}"`)
  const screen = flatten(await m.hierarchy()).find(node => node.bounds != null)?.bounds
  assert(screen != null, 'the screen has bounds')
  const x = ((part.box.x + part.box.width / 2) / screen.width) * 100
  const y = ((part.box.y + part.box.height / 2) / screen.height) * 100
  await m.tapOn({ point: `${x.toFixed(1)}%, ${y.toFixed(1)}%` })
}

/** The game's `liveState` in `GET /director/events`, as the runner sees it. */
async function directorLiveState(e: Env, gameId: string): Promise<string | undefined> {
  const response = await fetch(`https://${e.host}/api/v1/director/events`, {
    headers: { Authorization: `Bearer ${e.token}` }
  })
  assert.equal(response.status, 200, 'GET /director/events answered 200')
  const events = (await response.json()) as Array<{ gameId: string; liveState: string }>
  return events.find(one => one.gameId === gameId)?.liveState
}

/** One frame of the seat's live HLS, and the segment it was cut from. */
interface HlsFrame {
  path: string
  /** The segment's path on the seat. */
  segment: string
  /** When the seat wrote the segment, in milliseconds since the epoch. */
  writtenAt: number
}

const hlsConfigured = (): boolean =>
  process.env.SEAT_HLS_FRAME != null && process.env.SEAT_HLS_FRAME !== ''

/** What SEAT_HLS_FRAME printed last: `<segment> <mtime in seconds>`. */
function hlsSegment(path: string, printed: string): HlsFrame {
  const last = printed.trim().split('\n').at(-1) ?? ''
  const [segment, mtime] = last.trim().split(/\s+/)
  const writtenAt = Number(mtime) * 1_000
  assert(
    segment != null && segment !== '' && Number.isFinite(writtenAt) && writtenAt > 0,
    `SEAT_HLS_FRAME ends by printing "<segment> <mtime in seconds>" (it printed "${last}")`
  )
  return { path, segment, writtenAt }
}

/**
 * Writes a frame of the seat's live HLS to `name`.png in the artifact
 * directory, when SEAT_HLS_FRAME says how. HLS runs a few segments behind the
 * programme, so the caller waits for the change to reach it first.
 */
function hlsFrame(m: Device, name: string): HlsFrame | undefined {
  if (!hlsConfigured()) {
    console.log('  SEAT_HLS_FRAME is not set: read a frame of the live HLS by hand')
    return undefined
  }
  const path = `${m.artifactDir}/${name}.png`
  const frame = hlsSegment(path, seat('SEAT_HLS_FRAME', path))
  console.log(`  live HLS frame ${path} (${frame.segment})`)
  return frame
}

/** `hlsFrame`, without holding up the rest of the run while it works. */
async function hlsFrameSoon(path: string): Promise<HlsFrame> {
  stepGuard('reading the live HLS')
  const [command, ...rest] = required('SEAT_HLS_FRAME').split(' ')
  const printed = await new Promise<string>((resolve, reject) => {
    execFile(command, [...rest, path], { encoding: 'utf8' }, (error, stdout) => {
      if (error != null) reject(error)
      else resolve(stdout)
    })
  })
  stepGuard('after reading the live HLS')
  return hlsSegment(path, printed)
}

/**
 * Where the board and the same size beside it are in a picture of the whole
 * programme, such as a frame of the live HLS: the same shares of it as on
 * the preview, in its pixels.
 */
function frameSpots(picture: Picture, placement: Placement): ProgrammeSpots {
  const board = {
    x: (placement.x + placement.width * 0.1) * picture.width,
    y: (placement.y + placement.height * 0.1) * picture.height,
    width: placement.width * 0.8 * picture.width,
    height: placement.height * 0.8 * picture.height
  }
  const beside = { ...board, x: board.x + placement.width * 1.5 * picture.width }
  return { board, beside, scale: 1 }
}

/** Asserts the board is drawn at its placed spot in a frame of the live HLS. */
function assertDrawnInFrame(frame: HlsFrame, placement: Placement, label: string): void {
  const picture = readPng(readFileSync(frame.path))
  const spots = frameSpots(picture, placement)
  const reading = {
    board: tally(picture, 1, spots.board),
    beside: tally(picture, 1, spots.beside)
  }
  console.log(
    `  ${label}: live HLS ${picture.width} x ${picture.height}, ${describeReading(reading)}`
  )
  assert(
    boardShown(reading),
    `${label}: the board is drawn in the live HLS frame (${describeReading(reading)})`
  )
}

/** Takes that belong to a game, from the seat's database. */
function liveStreams(gameId: string): number {
  return Number(sql(`select count(*) from live_streams where game_id = '${gameId}'`))
}

/** What a take linked to a seeded game says on its upload button. */
const LINKED_TITLE = 'UPLOAD TO SCOREBOARD E2E VISITORS AT SCOREBOARD E2E'

/** Opens Recordings and selects the newest take, whose row is at the top. */
async function selectNewestTake(m: Device): Promise<string> {
  await m.tapOn({ id: 'recordings-button' })
  await m.extendedWaitUntil({ visible: { id: 'recordings-dates' }, timeout: 10_000 })
  const newest = flatten(await m.hierarchy())
    .filter(n => n.id?.startsWith('recording-row-') === true && n.bounds != null)
    .sort((a, b) => (a.bounds?.y ?? 0) - (b.bounds?.y ?? 0))[0]
  assert(newest?.id != null, 'the Recordings list shows the take')
  await m.tapOn({ id: newest.id })
  await m.extendedWaitUntil({ visible: { id: 'recordings-upload' }, timeout: 5_000 })
  return newest.id
}

// MARK: - The stream URL

const PRODUCTION_HOSTS = ['gamestation.co', 'www.gamestation.co']
const PRODUCTION_RTMP_PORT = 1936

/**
 * Why `url` would publish to production, or undefined when it would not:
 * production's own names on any port, or port 1936 on the production droplet
 * under any name or address (the seats share the droplet, on 1935). A 1936
 * URL whose host cannot be looked up is refused too: it cannot be shown not
 * to be production.
 */
async function productionReason(url: string): Promise<string | undefined> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return 'it is not a URL'
  }
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '')
  if (PRODUCTION_HOSTS.includes(host)) return `${host} is production`
  const port = parsed.port === '' ? 1935 : Number(parsed.port)
  if (port !== PRODUCTION_RTMP_PORT) return undefined
  const addresses = async (name: string): Promise<string[]> =>
    (await lookup(name, { all: true })).map(one => one.address)
  const production = new Set((await Promise.all(PRODUCTION_HOSTS.map(addresses))).flat())
  const mine = await addresses(host).catch(() => undefined)
  if (mine == null) return `port ${port} on ${host}, which does not resolve`
  if (mine.some(address => production.has(address))) {
    return `port ${port} on ${host} is production's ingest`
  }
  return undefined
}

/** A stream URL for a log: its key cut short. */
const redacted = (url: string): string => url.replace(/(\/live\/.{6}).*/, '$1…')

/** The stream URL Settings shows now. Settings must be open. */
async function streamUrlField(m: Device): Promise<string> {
  await showInSettings(m, 'settings-stream-url')
  const node = flatten(await m.hierarchy()).find(n => n.id === 'settings-stream-url')
  return node?.text ?? ''
}

/**
 * Which destination radio is on. The radios carry no state in the hierarchy,
 * so it is read from the screenshot: the chosen one is filled with the accent
 * colour, the other is a thin grey ring.
 */
async function streamDestination(m: Device): Promise<'event' | 'url'> {
  await showInSettings(m, 'settings-stream-url')
  const { picture, scale } = await screenPicture(m)
  const coloured = async (id: string): Promise<number> => {
    const box = await boundsOf(m, id)
    assert(box != null, `${id} is on screen`)
    let count = 0
    for (let y = Math.round(box.y * scale); y < Math.round((box.y + box.height) * scale); y++) {
      for (let x = Math.round(box.x * scale); x < Math.round((box.x + box.width) * scale); x++) {
        const [r, g, b] = picture.rgb(x, y)
        if (Math.max(r, g, b) - Math.min(r, g, b) >= 60) count++
      }
    }
    return count
  }
  const event = await coloured('settings-stream-destination-event')
  const url = await coloured('settings-stream-destination-url')
  assert(event !== url, `one stream destination is chosen (${event} and ${url} accent pixels)`)
  return event > url ? 'event' : 'url'
}

/** Types `url` as the stream URL. Settings must be open. */
async function typeStreamUrl(m: Device, url: string): Promise<void> {
  await showInSettings(m, 'settings-stream-url')
  await m.tapOn({ id: 'settings-stream-url-clear', optional: true })
  await m.tapOn({ id: 'settings-stream-url' })
  await m.eraseText()
  await m.inputText({ text: url })
  await m.hideKeyboard()
  const typed = await streamUrlField(m)
  assert.equal(typed, url, 'Settings shows the stream URL just typed')
}

// MARK: - Leaving the iPad as it was

/**
 * Put back by `tidyUp` with Settings open, after the event is cleared. Each
 * must be safe to run twice: after an interruption it runs again.
 */
const restores: Array<{ doing: string; run: () => Promise<void> }> = []

/**
 * TIDY_UP_INTERRUPT, when set, names an app (e.g. com.apple.mobilecal) that
 * `tidyUp` brings to the front just before it opens Settings and again
 * before it saves, as a tapped notification banner would, to show that it
 * recovers. With TIDY_UP_INTERRUPT_AT=mid it does so in the middle of an
 * action instead (`interruptMidAction`).
 */
async function interruptForTest(m: Device, before: string): Promise<void> {
  const app = process.env.TIDY_UP_INTERRUPT ?? ''
  if (app === '' || process.env.TIDY_UP_INTERRUPT_AT === 'mid') return
  console.log(`  TIDY_UP_INTERRUPT: bringing ${app} to the front before ${before}`)
  await m.launchApp({ appId: app, stopApp: false })
  await sleep(2_000)
}

/** True while `tidyUp` runs, so the mid-action interruption spares the steps. */
let tidyingUp = false
/** The actions the mid-action interruption has already hit, once each. */
const interrupted = new Set<string>()

/**
 * With TIDY_UP_INTERRUPT_AT=mid, during the tidy-up, brings TIDY_UP_INTERRUPT's
 * app to the front between an action's tap and its check, once per action:
 * the check then fails with another app in front, which is what sends
 * `inDirector` down its "failed …; trying again once" path.
 */
async function interruptMidAction(m: Device, action: string): Promise<void> {
  const app = process.env.TIDY_UP_INTERRUPT ?? ''
  if (app === '' || process.env.TIDY_UP_INTERRUPT_AT !== 'mid') return
  if (!tidyingUp || interrupted.has(action)) return
  interrupted.add(action)
  console.log(`  TIDY_UP_INTERRUPT: bringing ${app} to the front in the middle of ${action}`)
  await m.launchApp({ appId: app, stopApp: false })
  await sleep(2_000)
}

/** Stops Record or Stream if it is on, through its slide-to-stop popup. */
async function stopCapture(m: Device, id: 'record-button' | 'stream-button'): Promise<void> {
  await inDirector(m, `stopping ${id}`, async () => {
    if (!(await isOn(m, id))) return
    console.log(`  tidying up: stopping ${id}`)
    // Tried again after an interruption, the popup may still be up.
    if ((await boundsOf(m, 'slide-to-stop-track')) == null) await toggleCapture(m, id)
    await interruptMidAction(m, `stopping ${id}`)
    await slideToStop(m)
    // A slide that landed on another app stopped nothing, and says nothing.
    const started = Date.now()
    while (await isOn(m, id)) {
      assert(Date.now() - started < 5_000, `${id} stopped after the slide`)
      await sleep(500)
    }
  })
}

/**
 * Runs after every step, passed or failed: closes whatever sheet the step
 * left open (a half-edited Settings is cancelled), stops Stream and Record,
 * then clears the event, puts back what the step changed, and saves. Each
 * of these first makes sure Director is in front, and is tried once more if
 * another app came to the front during it, so a notification banner that
 * takes a tap cannot leave an event chosen or R1's stream URL in place. It
 * ends with Director in front, idle, and no event chosen.
 */
async function tidyUp(m: Device): Promise<void> {
  tidyingUp = true
  try {
    for (let relaunches = 0; ; relaunches++) {
      try {
        await tidyUpNow(m)
        return
      } catch (error) {
        if (!(error instanceof SettingsUnreachable) || relaunches >= TIDY_UP_RELAUNCHES) throw error
        // Stream and Record were stopped before Settings was opened, so
        // stopping Director loses no take.
        console.error(
          `  tidying up: ${error.message}; launching Director again ` +
            `(${relaunches + 1} of ${TIDY_UP_RELAUNCHES}) and starting over`
        )
        await launchToGrid(m)
      }
    }
  } finally {
    tidyingUp = false
  }
}

/** How many times the tidy-up launches Director again when Settings will not open. */
const TIDY_UP_RELAUNCHES = 2

/** Settings would not open even after Director was brought back: something covers the grid. */
class SettingsUnreachable extends Error {}

/**
 * What covers the grid and how to close it, innermost first: a sheet or
 * popup over another sheet is closed before the one under it, and the launch
 * Cameras sheet (`start-directing`, DONE), which a Director launched again
 * mid-step shows over the grid, last.
 */
const CLOSERS = [
  'slide-to-stop-cancel',
  'recordings-export-reuse-cancel',
  'template-rename-cancel',
  'settings-new-template-cancel',
  'gamestation-sign-in-done',
  'upload-cancel',
  'event-picker-cancel',
  'color-picker-close',
  'overlay-edit-cancel',
  'text-overlay-done',
  'content-list-done',
  'content-editor-done',
  'remote-editor-done',
  'recordings-done',
  'settings-cancel',
  'camera-close',
  'digital-zoom-close',
  'source-preview-close',
  'source-waveform-close',
  'perf-done',
  'start-directing'
]

async function tidyUpNow(m: Device): Promise<void> {
  for (let closes = 0; ; closes++) {
    assert(closes < 10, 'tidying up got back to the grid')
    if (await bringDirectorBack(m, 'tidying up')) continue
    const ids = new Set(flatten(await m.hierarchy()).map(n => n.id))
    // The grid's settings-button is in the hierarchy under any sheet, so
    // what covers it is looked for first.
    const close = CLOSERS.find(id => ids.has(id))
    if (close != null) {
      console.log(`  tidying up: closing ${close}`)
      await m.tapOn({ id: close })
      await sleep(close === 'start-directing' ? 3_000 : 1_000)
    } else if (ids.has('settings-button')) {
      break
    } else {
      // The Photos picker, or a keyboard over a sheet.
      await m.tapOn({ text: 'Cancel', optional: true })
      await m.hideKeyboard().catch(() => undefined)
    }
  }
  for (const id of ['stream-button', 'record-button'] as const) await stopCapture(m, id)
  await interruptForTest(m, 'opening Settings')
  try {
    await openSettings(m)
  } catch (error) {
    if (isSessionError(error)) throw error
    throw new SettingsUnreachable(
      `Settings did not open (${error instanceof Error ? error.message : String(error)})`
    )
  }
  await clearEvent(m)
  for (const restore of restores.splice(0)) {
    await inDirector(m, restore.doing, restore.run)
  }
  await interruptForTest(m, 'saving Settings')
  await saveSettings(m)
  await bringDirectorBack(m, 'tidying up')
  assert.equal((await frontApp(m)) ?? DIRECTOR_NAME, DIRECTOR_NAME, 'Director is in front')
  assert(!(await isOn(m, 'record-button')), 'Director is not recording')
  assert(!(await isOn(m, 'stream-button')), 'Director is not streaming')
  console.log('  tidied up: Director is in front and idle, with no event chosen')
}

// MARK: - The steps

/** D1: an event links a record-only take, and a take already running. */
async function eventRecording(m: Device, e: Env): Promise<void> {
  const id = game(e, '-10m')
  await launch(m)
  await openSettings(m)
  await signIn(m)
  await clearEvent(m)
  await m.tapOn({ id: 'settings-stream-destination-url' })
  await saveSettings(m)

  await toggleCapture(m, 'record-button')
  await sleep(10_000)
  await openSettings(m)
  await pickEvent(m, id)
  await saveSettings(m)
  await sleep(10_000)
  await toggleCapture(m, 'record-button')
  await slideToStop(m)
  await record(m, 10)

  assert.equal(liveStreams(id), 0, 'nothing was claimed for a record-only event')
  await openSettings(m)
  await m.shot('d1-settings')
  await saveSettings(m)

  await m.tapOn({ id: 'recordings-button' })
  await m.extendedWaitUntil({ visible: { id: 'recordings-dates' }, timeout: 10_000 })
  // A take linked to a game names it, upper-cased, on the upload button of
  // the selected row. The two newest rows are this step's takes.
  const rows = flatten(await m.hierarchy())
    .filter(n => n.id?.startsWith('recording-row-') === true && n.bounds != null)
    .sort((a, b) => (a.bounds?.y ?? 0) - (b.bounds?.y ?? 0))
    .slice(0, 2)
  assert.equal(rows.length, 2, 'the Recordings list shows two takes')
  for (const row of rows) {
    await m.tapOn({ id: row.id })
    await m.extendedWaitUntil({
      visible: { id: 'recordings-upload', text: LINKED_TITLE },
      timeout: 5_000
    })
    console.log(`  ${row.id} (${row.text ?? ''}) is titled with the game`)
    await m.shot(`d1-${row.id ?? 'row'}`)
  }
}

/** D2: choosing the event destination claims it. */
async function eventStream(m: Device, e: Env): Promise<void> {
  const id = game(e, '-10m')
  await launch(m)
  await openSettings(m)
  await signIn(m)
  await pickEvent(m, id)
  await showInSettings(m, 'settings-stream-destination-event')
  await m.tapOn({ id: 'settings-stream-destination-event' })
  await saveSettings(m)
  await toggleCapture(m, 'stream-button')
  await sleep(30_000)
  assert.equal(liveStreams(id), 1, 'the event was claimed')
  const state = sql(`select state from live_streams where game_id = '${id}'`)
  assert.equal(state, 'publishing', 'the stream is publishing')
  assert.equal(
    await directorLiveState(e, id),
    'publishing',
    'GET /director/events shows liveState publishing'
  )
  await m.shot('d2-streaming')
  await toggleCapture(m, 'stream-button')
  await slideToStop(m)
  await toggleCapture(m, 'record-button')
  await slideToStop(m)

  // After stop, the take is linked to the game: its upload button names it.
  const take = await selectNewestTake(m)
  await m.extendedWaitUntil({
    visible: { id: 'recordings-upload', text: LINKED_TITLE },
    timeout: 5_000
  })
  console.log(`  ${take} is linked to the game`)
  await m.shot('d2-take-linked')
  await m.tapOn({ id: 'recordings-done' })

  await openSettings(m)
  await showInSettings(m, 'settings-gamestation-event')
  await m.tapOn({ id: 'settings-gamestation-event-clear' })
  await m.assertVisible({ text: 'GameStation event — pick one above' })
  await m.shot('d2-cleared')
  await saveSettings(m)
}

/** D3: place and resize the sample. */
async function placeSample(m: Device, e: Env): Promise<void> {
  await launch(m)
  await openSettings(m)
  await clearEvent(m)
  await openContentEditor(m)
  const before = await overlayHandles(m)
  await m.tapOn({ id: 'content-add' })
  await m.tapOn({ id: 'content-add-scoreboard' })
  await sleep(5_000)
  await m.shot('d3-sample-centre')
  webcam('the sample board in the centre quarter, no fill around it')
  // The centre quarter: a quarter of the preview wide (a page of B, 607 wide,
  // at 480/607 of a 1920 programme), centred on it.
  const grip = 22
  const added = [...(await overlayHandles(m)).entries()].filter(([id]) => !before.has(id))
  assert.equal(added.length, 1, 'one overlay was added')
  const first = added[0][1]
  const shown = { width: first.width - 2 * grip, height: first.height - 2 * grip }
  const centre = { x: first.x + first.width / 2, y: first.y + first.height / 2 }
  console.log(
    `  added at ${JSON.stringify(first)}: ${shown.width} x ${shown.height} pt, ` +
      `${(shown.width / PREVIEW.width).toFixed(3)} of the preview wide`
  )
  assert(
    Math.abs(shown.width / PREVIEW.width - 0.25) < 0.03,
    `the board is about a quarter of the preview wide (${shown.width} of ${PREVIEW.width} pt)`
  )
  assert(
    Math.abs(centre.x - (PREVIEW.x + PREVIEW.width / 2)) < 20 &&
      Math.abs(centre.y - (PREVIEW.y + PREVIEW.height / 2)) < 20,
    `the board is centred on the preview (${centre.x}, ${centre.y})`
  )
  const board = added[0][0]
  await assertBoardDrawn(m, board, 'the sample in the centre')
  await m.tapOn({ id: 'content-add' })
  await m.assertVisible({ id: 'content-add-scoreboard', enabled: false })
  await m.tapOn({ text: 'Cancel' })

  // Bottom-left, about half its width: half of a quarter of the preview.
  const size = await placeOverlay(m, board, PREVIEW.width / 8, bottomLeft(30))
  await sleep(10_000)
  const kept = (await overlayHandles(m)).get(board)
  assert.deepEqual(kept, size, 'the board keeps its place and size across two snapshots')
  await assertBoardDrawn(m, board, 'the placed sample')
  await m.shot('d3-placed')
  webcam('the board keeps its place and size after two snapshots')
  await closeContentEditor(m)
  console.log(
    '  read overlays.json off the iPad with devicectl and compare its rect with the screenshot'
  )

  const later = game(e, '+1h')
  await pickEvent(m, later)
  closeScoreboard(later)
  await openContentEditor(m)
  await sleep(5_000)
  await assertBoardDrawn(m, board, 'the sample for a closed event')
  await m.shot('d3-closed-event-sample')
  webcam('the sample still shows for a chosen event whose scoreboard closed')
  await closeContentEditor(m)
  // tidyUp clears the event and saves.
}

/** D4: hidden with no event. */
async function hiddenWithoutEvent(m: Device, e: Env): Promise<void> {
  await launch(m)
  await openSettings(m)
  await clearEvent(m)
  await activateBoardTemplate(m)
  await saveSettings(m)
  const spots = await programmeSpots(m, placedBoard(e, m))
  await toggleCapture(m, 'record-button')
  await sleep(5_000)
  await awaitProgramme(m, spots, 'absent', 0, 'no event, recording')
  await m.shot('d4-no-board')
  await sleep(5_000)
  await toggleCapture(m, 'record-button')
  await slideToStop(m)
  webcam('no board on the preview')
  console.log('  export a frame of the take with the gs-distributor-api skill: no board')
}

/**
 * Picks the game, makes the board's template the active one, chooses the
 * event destination and saves; then reads where the board is placed.
 */
async function coverEvent(
  m: Device,
  e: Env,
  id: string
): Promise<{ placement: Placement; spots: ProgrammeSpots }> {
  await launch(m)
  await openSettings(m)
  await pickEvent(m, id)
  await activateBoardTemplate(m)
  await showInSettings(m, 'settings-stream-destination-event')
  await m.tapOn({ id: 'settings-stream-destination-event' })
  await saveSettings(m)
  const placement = placedBoard(e, m)
  return { placement, spots: await programmeSpots(m, placement) }
}

/** Taps Stream and waits for it to read STREAMING. */
async function startStreaming(m: Device): Promise<void> {
  await toggleCapture(m, 'stream-button')
  const started = Date.now()
  while (!(await isOn(m, 'stream-button'))) {
    assert(Date.now() - started < 30_000, 'Stream reads STREAMING within 30 s')
    await sleep(1_000)
  }
  console.log(`  streaming after ${((Date.now() - started) / 1_000).toFixed(1)} s`)
}

/**
 * Reads frames of the live HLS until the board's crop differs from `before`
 * (the frame read just before the change) by what `changedFrom` asks, and
 * by more than `before.noise`, with the board still drawn, and fails after
 * `within` ms from `since`. Only a frame of a segment the seat wrote after
 * `since` counts: one written before the send cannot show the change, and
 * the latency is then always positive. Returns the frame, and how long after
 * `since` the seat wrote its segment.
 */
async function awaitHlsChange(
  m: Device,
  name: string,
  placement: Placement,
  before: { frame: HlsFrame; noise: number },
  since: number,
  within: number,
  label: string
): Promise<{ frame: HlsFrame; writtenAfter: number }> {
  const was = hlsCrop(before.frame, placement)
  let last = 'nothing read'
  for (let tries = 0; ; tries++) {
    const frame = await hlsFrameSoon(`${m.artifactDir}/${name}-${tries}.png`).catch(
      (error: unknown) => {
        last = `SEAT_HLS_FRAME failed: ${String(error)}`
        return undefined
      }
    )
    if (frame != null && frame.writtenAt <= since) {
      last = `${frame.segment}, written ${frame.writtenAt - since} ms after the send: too early to count`
    } else if (
      frame != null &&
      frame.segment !== before.frame.segment &&
      videoOf(frame) === videoOf(before.frame)
    ) {
      const { share, changed } = changedFrom('hls', was, hlsCrop(frame, placement), before.noise)
      const writtenAfter = frame.writtenAt - since
      last =
        `${frame.segment}, written ${writtenAfter} ms after, ${fine(share)} of the board ` +
        `moved (noise ${fine(before.noise)})`
      if (changed && share > before.noise) {
        console.log(`  ${label}: live HLS changed in ${last}`)
        assertDrawnInFrame(frame, placement, label)
        return { frame, writtenAfter }
      }
    }
    assert(
      Date.now() - since < within,
      `${label}: a live HLS frame shows the new state within ${within / 1_000} s (${last})`
    )
    await sleep(500)
  }
}

/** The seat's video a live HLS frame was cut from: its segment's folder. */
const videoOf = (frame: HlsFrame): string => frame.segment.split('/').slice(0, -1).join('/')

/**
 * Two frames of the live HLS from different segments of the same video,
 * before any change:
 * the second to compare with, and how much of the board moved between them,
 * which is the coding noise of an unchanged board.
 */
async function hlsBefore(
  m: Device,
  name: string,
  placement: Placement
): Promise<{ frame: HlsFrame; noise: number }> {
  let first = await hlsFrameSoon(`${m.artifactDir}/${name}-a.png`)
  const started = Date.now()
  for (;;) {
    await sleep(1_000)
    const second = await hlsFrameSoon(`${m.artifactDir}/${name}-b.png`)
    // Just after Stream starts, the newest segment can still be the last
    // one of the seat's previous video: compare two of this one.
    if (videoOf(second) !== videoOf(first)) {
      copyFileSync(second.path, `${m.artifactDir}/${name}-a.png`)
      first = { ...second, path: `${m.artifactDir}/${name}-a.png` }
    } else if (second.segment !== first.segment) {
      const noise = changedShare(
        hlsCrop(first, placement),
        hlsCrop(second, placement),
        CHANGED.hls.step
      )
      console.log(
        `  live HLS before the change: ${fine(noise)} of the unchanged board moved ` +
          `between ${first.segment.split('/').at(-1) ?? ''} and ` +
          `${second.segment.split('/').at(-1) ?? ''}`
      )
      assertDrawnInFrame(second, placement, `${name}, before the change`)
      return { frame: second, noise }
    }
    assert(Date.now() - started < 15_000, 'the seat writes a new live HLS segment within 15 s')
  }
}

/** D5: live on the programme. */
async function liveOnProgramme(m: Device, e: Env): Promise<void> {
  const id = game(e, '-10m')
  const { placement, spots } = await coverEvent(m, e, id)
  // A known board to start from, so the 3-1 publish is a change even when
  // an earlier run left 3-1 behind.
  const reset = await publish(`https://${e.host}`, id, e.token, {
    balls: 0,
    strikes: 0,
    outs: 0,
    base1: false,
    base2: false,
    base3: false
  })
  assert(reset.delivered, `the reset was accepted (${JSON.stringify(reset)})`)
  await override(`https://${e.host}`, id, e.token, NO_OVERRIDES)
  await startStreaming(m)
  await sleep(10_000)

  // Each change is judged against the board as it was just before it, so a
  // board that was already drawn (at 0-0, from D3) does not pass for it.
  const changes = [
    {
      label: 'streaming, after the 3-1 publish',
      name: 'd5-live-3-1',
      hls: 'd5-hls-3-1',
      webcam: '3-1, two outs, second base, at the place D3 left it',
      send: async () =>
        await publish(`https://${e.host}`, id, e.token, {
          balls: 3,
          strikes: 1,
          outs: 2,
          base2: true
        })
    },
    {
      label: 'streaming, after the 0-0 override',
      name: 'd5-override-0-0',
      hls: 'd5-hls-0-0',
      webcam: '0-0 from the override',
      send: async () =>
        await override(`https://${e.host}`, id, e.token, {
          ...NO_OVERRIDES,
          overrideCountEnabled: true,
          overrideCount: { balls: 0, strikes: 0, outs: 0 }
        })
    }
  ]
  const latencies: string[] = []
  for (const change of changes) {
    const before = await previewBefore(m, spots)
    const hls = hlsConfigured() ? await hlsBefore(m, `${change.hls}-before`, placement) : undefined
    const sentAt = Date.now()
    const sent = await change.send()
    assert(sent.delivered, `${change.label}: the change was accepted (${JSON.stringify(sent)})`)
    const shown = await awaitPreviewChange(m, spots, before, sentAt, 3_000, change.label)
    writeFileSync(`${m.artifactDir}/${change.name}-${shown.at}ms.png`, shown.png)
    latencies.push(`${change.label}: preview ${shown.after}–${shown.at} ms`)
    webcam(change.webcam)
    if (hls == null) {
      hlsFrame(m, change.hls)
      continue
    }
    // HLS runs a few segments behind the programme, and D5 sets it no limit.
    const live = await awaitHlsChange(m, change.hls, placement, hls, sentAt, 30_000, change.label)
    latencies[latencies.length - 1] += `, live HLS segment written ${live.writtenAfter} ms after`
  }
  console.log('  D5, from each send to the first differing crop:')
  for (const line of latencies) console.log(`    ${line}`)
  await override(`https://${e.host}`, id, e.token, NO_OVERRIDES)

  await toggleCapture(m, 'stream-button')
  await slideToStop(m)
  await toggleCapture(m, 'record-button')
  await slideToStop(m)
}

/** D6: clearing the event, or a closed scoreboard, removes the board. */
async function clearedOrClosed(m: Device, e: Env): Promise<void> {
  const id = game(e, '-10m')
  await launch(m)
  await openSettings(m)
  await pickEvent(m, id)
  await activateBoardTemplate(m)
  await saveSettings(m)
  const spots = await programmeSpots(m, placedBoard(e, m))
  // Without a board before the clear, its absence after would prove nothing.
  await awaitProgramme(m, spots, 'drawn', 20_000, 'the chosen event')
  await m.shot('d6-before-clear')

  await openSettings(m)
  await clearEvent(m)
  await saveSettings(m)
  await awaitProgramme(m, spots, 'absent', 3_000, 'cleared')
  await m.shot('d6-cleared')
  webcam('the board has left the preview')

  await openSettings(m)
  await pickEvent(m, id)
  await saveSettings(m)
  await awaitProgramme(m, spots, 'drawn', 20_000, 'chosen again')
  closeScoreboard(id)
  // The hub checks every 60 s for a board that has closed.
  await sleep(70_000)
  await awaitProgramme(m, spots, 'absent', 0, 'closed: no board and no 404 card')
  await m.shot('d6-closed')
  webcam('no board and no 404 card')
}

/** What a `/scoreboard/<id>` page shows: its count and the two scores. */
interface ShownBoard {
  count: string
  homeScore: string
  awayScore: string
}

/** Where each change reached, in milliseconds from when it was sent. */
interface Reached {
  browser?: number
  /** The screenshot before the first that showed it came back this long after the send. */
  previewAfter?: number
  preview?: number
  previewError?: string
  hls?: number
  hlsSegment?: string
}

/** How long F1 steps 3–4 give each change to reach all three places. */
const F1_WITHIN = 5_000

/**
 * F1 steps 3–4: with the − 10 m game chosen and Director streaming to the
 * event destination, three pitches are published from the Mac (standing in
 * for Watcher, whose leg of F1 step 3 Paul skipped), then the
 * home score is overridden through the dashboard socket. Within 5 s of each
 * change:
 *
 * - the board on Director's preview shows the new state: its crop differs
 *   from the crop taken just before the send (`changedFrom`), and it is
 *   still drawn at its placed spot;
 * - a `/scoreboard/<id>` page in a browser (Puppeteer) shows the new value;
 * - the seat has written, after the send, a live HLS segment whose last
 *   frame (SEAT_HLS_FRAME) differs at the board, by more than the noise, from
 *   a frame read just before this change's send, with the board drawn. The
 *   frame before and the noise (two unchanged frames) are read afresh for
 *   each change. The time is the segment's mtime on the seat less the send
 *   on the Mac, so the two clocks must agree (both keep NTP time); a time
 *   that is not positive fails.
 *
 * Each time is to the first differing crop. The first differing preview shot
 * and HLS frame are saved for reading the value by eye. It prints each
 * change's latencies, and fails on any over 5 s.
 */
async function fullPass34(m: Device, e: Env): Promise<void> {
  const id = game(e, '-10m')
  const host = `https://${e.host}`
  const { placement, spots } = await coverEvent(m, e, id)
  // A known count to start from, and no overrides.
  const reset = await publish(host, id, e.token, { balls: 0, strikes: 0, outs: 0 })
  assert(reset.delivered, `the reset was accepted (${JSON.stringify(reset)})`)
  await override(host, id, e.token, NO_OVERRIDES)

  const { default: puppeteer } = await import('puppeteer')
  const browser = await puppeteer.launch({
    headless: true,
    ...(process.env.GS_CHROME_PATH != null && process.env.GS_CHROME_PATH !== ''
      ? { executablePath: process.env.GS_CHROME_PATH }
      : {})
  })
  const results: Array<{ label: string; reached: Reached }> = []
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1280, height: 720 })
    await page.goto(`${host}/scoreboard/${id}`, { waitUntil: 'load' })
    await page.waitForSelector('[data-scoreboard="count"]', { timeout: 30_000 })
    // Runs in the page: no `?.` or `??`, which sucrase turns into helpers
    // the page does not have.
    const shown = async (): Promise<ShownBoard> =>
      await page.evaluate(() => {
        const part = (name: string): string => {
          const node = document.querySelector(`[data-scoreboard="${name}"]`)
          return node === null ? '' : String(node.textContent)
        }
        return { count: part('count'), homeScore: part('homeScore'), awayScore: part('awayScore') }
      })
    const start = await shown()
    console.log(`  the browser shows ${JSON.stringify(start)}`)
    assert(start.count.startsWith('0-0'), `the browser starts at 0-0 (${start.count})`)

    await startStreaming(m)
    // Until the seat has written a segment, there is no live HLS to read.
    for (let tries = 0; ; tries++) {
      const first = await hlsFrameSoon(`${m.artifactDir}/f1-hls-first.png`).catch(error => {
        assert(tries < 15, `the seat writes live HLS within 45 s of STREAMING (${String(error)})`)
        return undefined
      })
      if (first != null) break
      await sleep(3_000)
    }

    const home = Number(start.homeScore === '' ? '0' : start.homeScore)
    const away = Number(start.awayScore === '' ? '0' : start.awayScore)
    const changes: Array<{
      label: string
      send: () => Promise<{ delivered: boolean }>
      shows: (board: ShownBoard) => boolean
    }> = [
      {
        label: 'publish 1-0',
        send: async () => await publish(host, id, e.token, { balls: 1 }),
        shows: board => board.count.startsWith('1-0')
      },
      {
        label: 'publish 1-1',
        send: async () => await publish(host, id, e.token, { strikes: 1 }),
        shows: board => board.count.startsWith('1-1')
      },
      {
        label: 'publish 2-1',
        send: async () => await publish(host, id, e.token, { balls: 2 }),
        shows: board => board.count.startsWith('2-1')
      },
      {
        label: `override home ${home + 1}`,
        send: async () =>
          await override(host, id, e.token, {
            ...NO_OVERRIDES,
            overrideScoreEnabled: true,
            overrideScore: { homeScore: home + 1, awayScore: away }
          }),
        shows: board => board.homeScore === String(home + 1)
      }
    ]

    for (const [n, change] of changes.entries()) {
      const name = `f1-${n + 1}`
      const reached: Reached = {}
      // The board as it is now, on the live HLS and on the preview, each read
      // afresh for this change, with the noise between two unchanged frames:
      // so neither a board already drawn nor the last change passes for it.
      const hls = await hlsBefore(m, `${name}-hls-before`, placement)
      const before = await previewBefore(m, spots)
      const sentAt = Date.now()
      const sending = change.send()

      const toBrowser = (async () => {
        while (Date.now() - sentAt < F1_WITHIN) {
          if (change.shows(await shown())) {
            reached.browser = Date.now() - sentAt
            return
          }
          await sleep(20)
        }
      })()

      const toPreview = (async () => {
        try {
          const changed = await awaitPreviewChange(m, spots, before, sentAt, F1_WITHIN, change.label)
          writeFileSync(`${m.artifactDir}/${name}-preview-${changed.at}ms.png`, changed.png)
          reached.preview = changed.at
          reached.previewAfter = changed.after
        } catch (error) {
          reached.previewError = error instanceof Error ? error.message : String(error)
        }
      })()

      // Reads the live HLS until its board differs from the frame before.
      const toHls = (async () => {
        try {
          const changed = await awaitHlsChange(
            m, name + '-hls', placement, hls, sentAt, F1_WITHIN + 10_000, change.label
          )
          reached.hls = changed.writtenAfter
          reached.hlsSegment = changed.frame.segment
        } catch (error) {
          reached.hlsSegment = error instanceof Error ? error.message : String(error)
        }
      })()

      const outcome = await sending
      assert(outcome.delivered, `${change.label} was accepted (${JSON.stringify(outcome)})`)
      await Promise.all([toBrowser, toPreview, toHls])
      const ms = (value: number | undefined): string => (value == null ? 'never' : `${value} ms`)
      console.log(
        `  ${change.label}: browser ${ms(reached.browser)}, preview ${ms(reached.preview)}, ` +
          `live HLS ${ms(reached.hls)} (${reached.hlsSegment ?? 'no new segment'})`
      )
      results.push({ label: change.label, reached })
      assert(
        reached.browser != null && reached.browser <= F1_WITHIN,
        `${change.label}: the browser shows it within 5 s (${ms(reached.browser)}; ` +
          `${JSON.stringify(await shown())})`
      )
      assert(
        reached.preview != null,
        reached.previewError ?? `${change.label}: the preview shows it within 5 s`
      )
      assert(
        reached.hls != null && reached.hls > 0 && reached.hls <= F1_WITHIN,
        `${change.label}: the seat wrote a live HLS segment showing it within 5 s ` +
          `(${ms(reached.hls)}; ${reached.hlsSegment ?? 'nothing read'})`
      )
      await m.shot(`${name}-after`)
      // Leave room between changes, so each one's segment is its own.
      await sleep(6_000)
    }
  } finally {
    await browser.close().catch(() => undefined)
    await override(host, id, e.token, NO_OVERRIDES).catch(() => undefined)
  }
  console.log(
    '  F1 steps 3–4, milliseconds from each send to the first differing crop ' +
      '(browser / preview, with the shot before it / live HLS):'
  )
  for (const { label, reached } of results) {
    console.log(
      `    ${label.padEnd(18)} ${String(reached.browser ?? '-').padStart(5)} / ` +
        `${String(reached.preview ?? '-').padStart(5)} (${String(reached.previewAfter ?? '-')}) / ` +
        `${String(reached.hls ?? '-').padStart(5)}`
    )
  }
  webcam('Director STREAMING, the board at its placed spot')
  await toggleCapture(m, 'stream-button')
  await slideToStop(m)
  await toggleCapture(m, 'record-button')
  await slideToStop(m)
}

/** What the system Photos picker shows: its title, sidebar and search field. */
const PHOTOS_PICKER_LABELS = [
  'Photos',
  'Collections',
  'Recently Saved',
  'Screenshots',
  'Albums',
  'Media Types',
  'Location Is Included'
]

/** Whether the Photos picker is up, by any of its labels or ids. */
async function photosPickerShown(m: Device): Promise<boolean> {
  return flatten(await m.hierarchy()).some(
    n =>
      PHOTOS_PICKER_LABELS.includes(n.text ?? '') ||
      /^Search your library/.test(n.text ?? '') ||
      /photo.?picker|PUPhotoPicker|PXGrid/i.test(n.id ?? '')
  )
}

/**
 * Taps "Choose a photo" and waits for the Photos picker, which runs in its
 * own process and can take more than 15 s to appear in the hierarchy (QA
 * round 5): up to 30 s, then the tap once more and 30 s again.
 */
async function openPhotosPicker(m: Device): Promise<void> {
  for (let taps = 1; ; taps++) {
    await m.tapOn({ id: 'overlay-edit-image' })
    const started = Date.now()
    while (Date.now() - started < 30_000) {
      if (await photosPickerShown(m)) return
      await sleep(1_000)
    }
    await m.shot('photos-picker-late')
    assert(taps < 2, 'the Photos picker appears within 30 s of the second tap')
    console.log('  the Photos picker did not appear within 30 s; tapping Choose a photo again')
  }
}

/**
 * The URL R1 streams to: R1_STREAM_URL, which must be set and must not be
 * production's. Checked before anything touches the iPad.
 */
async function r1Target(): Promise<string> {
  const target = process.env.R1_STREAM_URL ?? ''
  if (target === '') {
    throw new Error(
      'R1_STREAM_URL is required: R1 streams only to a URL it types itself. Claim a seeded ' +
        'game on the seat (POST /api/v1/director/events/<gameId>/claim as the e2e runner) and ' +
        'pass the rtmp://<seat>:1935/live/… `url` it answers.'
    )
  }
  const refused = await productionReason(target)
  if (refused != null) {
    throw new Error(`R1_STREAM_URL ${redacted(target)} is refused: ${refused}`)
  }
  return target
}

/** R1: the overlay and streaming areas this change touched. */
async function regression(m: Device, e: Env): Promise<void> {
  const target = await r1Target()
  await launch(m)
  await openSettings(m)
  await clearEvent(m)
  await openContentEditor(m)

  const before = await overlayHandles(m)
  await m.tapOn({ id: 'content-add' })
  await m.tapOn({ id: 'content-add-web' })
  await m.tapOn({ id: 'overlay-edit-url' })
  await m.eraseText()
  await m.inputText({ text: `https://${e.host}/scoreboard-sample` })
  await m.tapOn({ id: 'overlay-edit-save' })
  await sleep(5_000)
  // It lands a quarter of the preview wide, in the middle of it. Size it to
  // three eighths, then move it to the right-hand side, halfway down.
  const web = await addedHandle(m, before)
  const landed = await handleBox(m, web)
  const sized = await resizeOverlay(m, web, (PREVIEW.width * 3) / 8)
  const placed = await moveOverlay(m, web, rightAt(30, 0.5))
  console.log(
    `  ${web}: landed ${JSON.stringify(landed)} -> sized ${JSON.stringify(sized)} ` +
      `-> placed ${JSON.stringify(placed)}`
  )
  const grew = overlayRect(placed).width / overlayRect(landed).width - 1
  assert(
    Math.abs(grew) >= 0.2,
    `the web overlay was resized by at least 20% (${(grew * 100).toFixed(0)}%)`
  )
  const went = distance(landed, placed)
  assert(went >= 50, `the web overlay was moved at least 50 pt (${went.toFixed(0)} pt)`)
  console.log(`  the web overlay grew ${(grew * 100).toFixed(0)}% and moved ${went.toFixed(0)} pt`)
  await m.tapOn({ id: 'content-list' })
  const webRow = await listRow(m, t => t.includes('scoreboard-sample'))
  await tapInRow(m, webRow, 'Show in Live')
  await tapInRow(m, webRow, 'Show in Live')
  await tapInRow(m, webRow, 'Show in Rewind')
  await m.tapOn({ id: 'content-list-done' })
  await sleep(10_000)
  await m.shot('r1-web')
  const kept = (await overlayHandles(m)).get(web)
  assert(
    sameBox(kept, placed),
    `the web overlay keeps its new place and size across two snapshots ` +
      `(${JSON.stringify(kept)} after 10 s, ${JSON.stringify(placed)} placed)`
  )
  await assertBoardDrawn(m, web, 'the web overlay at its new place and size')
  webcam('the web overlay keeps its new size and place across two snapshots')

  // A text overlay, moved from where it lands to the left-hand side.
  const beforeText = await overlayHandles(m)
  await m.tapOn({ id: 'content-add' })
  await m.tapOn({ id: 'content-add-text' })
  await m.inputText({ text: 'R1' })
  await m.hideKeyboard()
  // Editing text, the overlay is a text field without a handle.
  await m.tapOn({ id: 'text-overlay-done', optional: true })
  await sleep(1_000)
  const text = await addedHandle(m, beforeText)
  const textLanded = await handleBox(m, text)
  const textPlaced = await moveOverlay(m, text, leftAt(30, 0.5))
  console.log(`  ${text}: landed ${JSON.stringify(textLanded)} -> placed ${JSON.stringify(textPlaced)}`)

  // An image overlay, moved from where it lands to the foot of the preview.
  const beforeImage = await overlayHandles(m)
  await m.tapOn({ id: 'content-add' })
  await m.tapOn({ id: 'content-add-image' })
  await openPhotosPicker(m)
  // Its grid starts right of the sidebar, so a point in the middle of the
  // grid is a photo.
  await sleep(2_000)
  await m.tapOn({ point: '68%, 47%' })
  await sleep(3_000)
  const image = await addedHandle(m, beforeImage)
  const imageLanded = await handleBox(m, image)
  const imagePlaced = await moveOverlay(m, image, bottomMiddle(30))
  console.log(
    `  ${image}: landed ${JSON.stringify(imageLanded)} -> placed ${JSON.stringify(imagePlaced)}`
  )
  await sleep(2_000)
  for (const [id, box] of [[web, placed], [text, textPlaced], [image, imagePlaced]] as const) {
    const now = (await overlayHandles(m)).get(id)
    assert(sameBox(now, box), `${id} stays where it was placed (${JSON.stringify(now)})`)
  }
  await m.shot('r1-overlays')
  webcam('each overlay draws where it was placed')

  // Delete the image just added, from its own edit sheet: an overlay held
  // still opens it. (The content list's last row can be below the sheet's
  // fold once earlier runs have left overlays in the template.)
  await m.tapOn({ id: image, longPress: true })
  await m.extendedWaitUntil({ visible: { id: 'overlay-edit-delete' }, timeout: 5_000 })
  await m.tapOn({ id: 'overlay-edit-delete' })
  await m.extendedWaitUntil({ notVisible: { id: image }, timeout: 5_000 })
  await m.shot('r1-image-deleted')
  await closeContentEditor(m)

  // The stream goes only to the URL typed here. What was saved is put back
  // by tidyUp, whatever happens.
  const saved = await streamUrlField(m)
  const savedDestination = await streamDestination(m)
  restores.push({
    doing: 'putting back the stream URL',
    run: async () => {
      await typeStreamUrl(m, saved)
      await showInSettings(m, `settings-stream-destination-${savedDestination}`)
      await m.tapOn({ id: `settings-stream-destination-${savedDestination}` })
      console.log(
        `  put back the stream URL ${redacted(saved)} and the ${savedDestination} destination`
      )
    }
  })
  const savedReason = await productionReason(saved)
  console.log(
    `  replacing the saved stream URL ${redacted(saved)} (${savedDestination} destination` +
      `${savedReason != null ? `; ${savedReason}` : ''})`
  )
  await typeStreamUrl(m, target)
  await showInSettings(m, 'settings-stream-destination-url')
  await m.tapOn({ id: 'settings-stream-destination-url' })
  await saveSettings(m)

  // Saved, the template holds the web and text overlays where they were
  // placed, and no longer the image.
  const template = activeOverlays(e, m)
  for (const [id, box] of [[web, placed], [text, textPlaced]] as const) {
    assertSavedAt(template.overlays, id, box)
  }
  const uuid = (id: string): string => id.replace(/^overlay-handle-/, '')
  assert(
    !template.overlays.some(o => o.id === uuid(image)),
    'overlays.json no longer has the deleted image'
  )
  // Before anything is sent, read back what was saved: the typed URL, chosen.
  await openSettings(m)
  const inEffect = await streamUrlField(m)
  assert.equal(inEffect, target, 'the saved stream URL is the one R1 typed')
  assert.equal(await streamDestination(m), 'url', 'the stream URL is the chosen destination')
  const inEffectReason = await productionReason(inEffect)
  assert(inEffectReason == null, `refusing to stream: ${inEffectReason ?? ''}`)
  await m.tapOn({ id: 'settings-cancel' })
  console.log(`  streaming to ${redacted(inEffect)}`)
  await toggleCapture(m, 'record-button')
  await toggleCapture(m, 'stream-button')
  await sleep(20_000)
  await toggleCapture(m, 'stream-button')
  await slideToStop(m)
  await toggleCapture(m, 'record-button')
  await slideToStop(m)
  // A take with a game names it on the upload button; this one has none.
  await selectNewestTake(m)
  await m.assertNotVisible({ text: '.*SCOREBOARD E2E.*' })
  await m.shot('r1-recordings')
}

const STEPS: Record<string, (m: Device, e: Env) => Promise<void>> = {
  eventRecording,
  eventStream,
  placeSample,
  hiddenWithoutEvent,
  liveOnProgramme,
  clearedOrClosed,
  fullPass34,
  regression
}

/**
 * Whether an error is the maestro-d session itself failing rather than a
 * check: the daemon gone, the device detached, or WebDriverAgent's socket
 * reset or closed under a command (QA round 4 saw `EOF` and
 * `connection reset by peer`, after which every call failed).
 */
function isSessionError(error: unknown): boolean {
  const code = (error as { code?: unknown } | undefined)?.code
  if (
    code === 'DEVICE_ERROR' ||
    code === 'DAEMON_UNAVAILABLE' ||
    code === 'DEVICE_NOT_ATTACHED' ||
    code === 'ECONNREFUSED' ||
    code === 'ECONNRESET' ||
    code === 'ENOENT'
  ) {
    return true
  }
  const message = error instanceof Error ? error.message : String(error)
  return /connection reset|connection refused|: EOF\b|socket hang up|DEVICE_ERROR|DAEMON_UNAVAILABLE|DEVICE_NOT_ATTACHED|ECONNREFUSED|ECONNRESET|invalid session id|session .* (not found|does not exist)/i.test(
    message
  )
}

/**
 * A fresh maestro-d session on the iPad: the old driver is detached, if the
 * daemon is still there to do it, and a new one attached, which starts the
 * daemon again when it has gone and WebDriverAgent again when it has reset.
 */
async function reattach(e: Env, m: Device): Promise<Device> {
  await m.detach().catch(() => undefined)
  return await attach({
    daemon: e.daemon,
    device: e.device,
    appId: APP_ID,
    artifactDir: `${m.artifactDir}/reattached`
  })
}

/**
 * How many fresh sessions the tidy-up opens after the session fails. More
 * than one: the first can die too. With the daemon killed mid-stream, the
 * fresh session attached 5 s later answered once and was then reset, as the
 * old daemon's WebDriverAgent went down under it.
 */
const FRESH_SESSIONS = 3

/**
 * Tidies up (`tidyUp`) on the session in `session.m`. When the session
 * itself fails, it opens a fresh one, keeps it in `session.m`, and tidies up
 * again from the start on it; up to FRESH_SESSIONS times, 5 s apart. Any
 * other failure is the tidy-up's own.
 */
async function tidyUpOrReattach(e: Env, session: { m: Device }): Promise<void> {
  for (let fresh = 0; ; fresh++) {
    try {
      await tidyUp(session.m)
      return
    } catch (error) {
      if (!isSessionError(error) || fresh >= FRESH_SESSIONS) throw error
      console.error(
        `  tidying up: the maestro-d session failed ` +
          `(${error instanceof Error ? error.message : String(error)}); ` +
          `opening a fresh one (${fresh + 1} of ${FRESH_SESSIONS})`
      )
      if (fresh > 0) await sleep(5_000)
      session.m = await reattach(e, session.m).catch(async (attachError: unknown) => {
        if (!isSessionError(attachError)) throw attachError
        // The daemon may still be shutting down: one more try.
        await sleep(5_000)
        return await reattach(e, session.m)
      })
      console.error('  tidying up: a fresh session is attached; tidying up again')
    }
  }
}

/**
 * Runs the tidy-up at most once however many ways the script ends: after the
 * step, on SIGINT or SIGTERM, or from the top-level catch. Resolves when it
 * has run, whether it passed or not.
 */
function tidyUpOnce(e: Env, session: { m: Device }): () => Promise<void> {
  let running: Promise<void> | undefined
  return async () => {
    running ??= tidyUpOrReattach(e, session).then(
      () => {
        tidiedUp = true
      },
      async (error: unknown) => {
        console.error(
          `  tidying up failed: ${error instanceof Error ? error.message : String(error)}`
        )
        await session.m.shot('tidy-up-failed').catch(() => undefined)
        throw error
      }
    )
    await running
  }
}

/** Set once the tidy-up has finished, for the exit hook's warning. */
let tidiedUp = false
/** The tidy-up of this run, once the iPad is attached. */
let tidyUpThisRun: (() => Promise<void>) | undefined

async function main(argv: string[]): Promise<void> {
  const at = argv.indexOf('--step')
  const name = at >= 0 ? argv[at + 1] : undefined
  const step = name != null ? STEPS[name] : undefined
  if (name == null || step == null) {
    throw new Error(`--step is one of ${Object.keys(STEPS).join(', ')}`)
  }
  const e = env()
  if (step === regression) await r1Target()
  if (step === fullPass34) {
    assert(hlsConfigured(), 'fullPass34 reads the live HLS: SEAT_HLS_FRAME is required')
  }
  const session = { m: await attach({ daemon: e.daemon, device: e.device, appId: APP_ID }) }
  const tidy = tidyUpOnce(e, session)
  tidyUpThisRun = tidy
  console.log(`▸ ${name} on ${e.device}`)
  let failure: unknown
  try {
    // The step drives the iPad through `guarded`, in `stepScope`, so that
    // once interrupted its own calls throw and the tidy-up's do not.
    const m = guarded(session.m)
    await stepScope.run(true, async () => {
      await step(m, e)
    })
  } catch (error) {
    failure = error
    if (!(error instanceof StepAborted)) {
      await session.m.shot(`${name}-failed`).catch(() => undefined)
    }
  }
  if (aborted != null) {
    console.error(
      `  the step stopped (${failure instanceof Error ? failure.message : 'it had ended'})`
    )
    // The signal's own handler runs the tidy-up and exits.
    await new Promise(() => undefined)
  }
  // Runs whether the step passed or not, so no step leaves an event chosen,
  // a take running or the stream URL changed.
  try {
    await tidy()
  } catch (error) {
    failure ??= error
  }
  if (failure != null) throw failure
  console.log(`✓ ${name}`)
}

/**
 * The ways out of the script other than `main` returning: each tidies up
 * first (at most once), so an interrupted run or a failure outside the step
 * still stops Stream and Record. `exit` cannot wait for anything, so it only
 * says when the tidy-up never finished.
 */
function tidyUpOnTheWayOut(): void {
  const leave = (code: number) => (why: unknown): void => {
    const reason =
      typeof why === 'string' ? why : why instanceof Error ? why.message : String(why)
    // First, so the step's next call throws and it drives nothing more.
    aborted ??= reason
    console.error(`${reason}: tidying up before exiting`)
    const tidy = tidyUpThisRun ?? (async () => undefined)
    stepCallsSettled(45_000)
      .then(tidy)
      .catch(() => undefined)
      .finally(() => process.exit(code))
  }
  process.once('SIGINT', () => leave(130)('SIGINT'))
  process.once('SIGTERM', () => leave(143)('SIGTERM'))
  process.once('unhandledRejection', leave(1))
  process.once('uncaughtException', leave(1))
  process.once('exit', () => {
    if (tidyUpThisRun != null && !tidiedUp) {
      console.error(
        'exiting before the tidy-up finished: check that Director is not recording or streaming'
      )
    }
  })
}

if ((process.argv[1] ?? '').endsWith('scoreboardDirector.e2e.ts')) {
  tidyUpOnTheWayOut()
  main(process.argv.slice(2)).catch(async (error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    // A failure outside the step (the step's own is tidied up in `main`)
    // still gets the one tidy-up, if the iPad was attached.
    await (tidyUpThisRun?.() ?? Promise.resolve()).catch(() => undefined)
    process.exit(1)
  })
}
