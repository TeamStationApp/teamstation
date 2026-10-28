/**
 * Adding existing players, on a real iPhone, through maestro-d: the scoring
 * Set Team Rosters (N1), team settings' Create Player and Add Player (N2),
 * Player Settings (N3) and the guardian's Reject (N4).
 *
 *   SCORING_DEVICE_UDID=<the phone> TS_E2E_TEAM_ID=<signing team> \
 *     MAESTRO_D=existingPlayerRoster \
 *     MAESTRO_D_CLIENT_ROOT=~/git/maestro-d/npm/maestro-d \
 *     TS_E2E_ARTIFACT_DIR=<directory> \
 *     [TS_E2E_WEBCAM_URL=<bench camera RTSPS URL> TS_E2E_WEBCAM_CROP=<w:h:x:y>] \
 *     node -r sucrase/register scripts/e2e/existingPlayer/existingPlayer.native.e2e.ts \
 *     [N1 N2 N3 N4] [SETTINGS | OFFLINE]
 *
 * The phone runs the Release build of `src/MOBILE.md` "Installing on a real
 * iPhone", built against this machine's API, signed out, over a fresh
 * fixture (`scripts/e2e/existingPlayer/fixture.ts`). Each screenshot that
 * proves a result is saved with a bench camera frame beside it as
 * `<name>-webcam.jpg` when the camera is named. The device id, the camera
 * and the password stay in the environment and the fixture file, never here.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const APP_ID = 'app.teamstation.app'
const FIXTURE_FILE =
  process.env.TS_E2E_FIXTURE ??
  '/private/tmp/teamstation-existingPlayer/fixture.json'
const UDID = process.env.SCORING_DEVICE_UDID
const ARTIFACTS = process.env.TS_E2E_ARTIFACT_DIR
if (UDID == null || ARTIFACTS == null)
  throw new Error('Set SCORING_DEVICE_UDID and TS_E2E_ARTIFACT_DIR')

interface Fixture {
  gameId: string
  password: string
  emails: Record<'coach' | 'guardian' | 'scorer' | 'heron', string>
  teams: Record<string, { id: string; name: string }>
}
const fixture = JSON.parse(readFileSync(FIXTURE_FILE, 'utf8')) as Fixture

const requireClient = createRequire(
  join(
    process.env.MAESTRO_D_CLIENT_ROOT ?? join(__dirname, 'node_modules'),
    'package.json'
  )
)
const { MaestroD } = requireClient('maestro-d')

type Device = any
let m: Device

interface Node {
  text?: string
  accessibilityText?: string
  bounds?: { x: number; y: number; width: number; height: number }
  children?: Node[]
}
/** Every label on screen, with where it is. */
async function labels(): Promise<
  Array<{ label: string; y: number; x: number; w: number; h: number }>
> {
  const flat = (node: Node): Node[] => [
    node,
    ...(node.children ?? []).flatMap(flat)
  ]
  return flat(await m.hierarchy())
    .map(node => ({
      label: node.text ?? node.accessibilityText ?? '',
      x: node.bounds?.x ?? 0,
      y: node.bounds?.y ?? 0,
      w: node.bounds?.width ?? 0,
      h: node.bounds?.height ?? 0
    }))
    .filter(node => node.label !== '')
}
async function onScreen(pattern: RegExp): Promise<boolean> {
  return (await labels()).some(node => pattern.test(node.label))
}
function check(ok: boolean, what: string): void {
  if (!ok) throw new Error(`Not so: ${what}`)
  console.log(`  ✔ ${what}`)
}
async function settle(ms = 1500): Promise<void> {
  await m.waitForAnimationToEnd({ timeout: ms })
}
async function tap(text: string): Promise<void> {
  await m.tapOn({ text, retryTapIfNoChange: false })
  await settle()
}
function ffmpeg(args: string[]): void {
  const result = spawnSync('ffmpeg', [
    '-nostdin',
    '-loglevel',
    'error',
    ...args
  ])
  if (result.status !== 0) throw new Error(`ffmpeg: ${String(result.stderr)}`)
}
/** The phone's screen, and the bench camera's view of it. */
/** The iPhone 15's screen in points, as the hierarchy's bounds are. */
const SCREEN = { width: 393, height: 852 }
/**
 * How many of a field's pixels are near a caret colour in `png`: the caret
 * blinks, so a shot that must show it is taken until one does.
 */
function caretPixels(
  png: Buffer,
  field: { x: number; y: number; w: number; h: number },
  colors: Array<[number, number, number]>
): number {
  const source = join(ARTIFACTS!, '.caret.png')
  writeFileSync(source, png)
  const box = [field.w, field.h, field.x, field.y]
    .map(
      (value, index) =>
        `i${index % 2 === 0 ? 'w' : 'h'}*${value}/${index % 2 === 0 ? SCREEN.width : SCREEN.height}`
    )
    .join(':')
  const result = spawnSync(
    'ffmpeg',
    [
      '-nostdin',
      '-loglevel',
      'error',
      '-i',
      source,
      '-vf',
      `crop=${box}`,
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      '-'
    ],
    { maxBuffer: 64 * 1024 * 1024 }
  )
  rmSync(source, { force: true })
  const raw = result.stdout
  let count = 0
  for (let at = 0; at + 2 < raw.length; at += 3)
    if (
      colors.some(
        ([r, g, b]) =>
          Math.abs(raw[at] - r) +
            Math.abs(raw[at + 1] - g) +
            Math.abs(raw[at + 2] - b) <
          60
      )
    )
      count++
  return count
}
/** A shot of the focused search field with its caret showing. */
async function caretShot(
  name: string,
  colors: Array<[number, number, number]>
): Promise<void> {
  await settle(1200)
  const field = (await labels())
    .filter(node => node.label === 'Search players')
    .sort((a, b) => a.w * a.h - b.w * b.h)[0]
  let best: Buffer | undefined
  let most = -1
  for (let attempt = 0; attempt < 6; attempt++) {
    const png: Buffer = await m.screenshot()
    const count = field == null ? 0 : caretPixels(png, field, colors)
    if (count > most) {
      best = png
      most = count
    }
    if (count > 30) break
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  check(most > 30, `${name} shows the caret (${most} caret pixels)`)
  await shot(name, best)
}
async function shot(name: string, taken?: Buffer): Promise<void> {
  if (taken == null) await settle(1200)
  writeFileSync(
    join(ARTIFACTS!, `${name}.png`),
    taken ?? (await m.screenshot())
  )
  const url = process.env.TS_E2E_WEBCAM_URL
  if (url == null) return
  const clip = join(ARTIFACTS!, `.${name}.mp4`)
  const crop = process.env.TS_E2E_WEBCAM_CROP ?? '440:400:1900:1110'
  ffmpeg(
    [
      '-rtsp_transport',
      'tcp',
      '-tls_verify',
      '0',
      '-timeout',
      '15000000'
    ].concat(['-i', url, '-t', '3', '-c', 'copy', '-y', clip])
  )
  // Two seconds in, once the camera's exposure has settled.
  ffmpeg([
    '-i',
    clip,
    '-ss',
    '2',
    '-frames:v',
    '1',
    '-vf',
    `crop=${crop},scale=-1:900`,
    '-q:v',
    '3',
    '-y',
    join(ARTIFACTS!, `${name}-webcam.jpg`)
  ])
  rmSync(clip, { force: true })
}

/** Signs the phone in from the sign-in screen as one of the fixture's people. */
async function signIn(who: keyof Fixture['emails']): Promise<void> {
  await m.launchApp({ appId: APP_ID, stopApp: true })
  await settle(3000)
  if (await onScreen(/^Your Home$/)) await signOut()
  if (await onScreen(/^Use a password instead$/))
    await tap('Use a password instead')
  await m.tapOn({ text: 'E-mail address' })
  await m.inputText({ text: fixture.emails[who] })
  await m.tapOn({ text: 'Password' })
  await m.inputText({ text: fixture.password })
  // Dismissing the keyboard presses its Go, which may sign in already.
  await m.hideKeyboard()
  await settle(3000)
  // The header says "Sign in" too: the button is the lowest of them.
  const button = (await labels())
    .filter(node => node.label === 'Sign in')
    .sort((a, b) => b.y - a.y)[0]
  if (button != null && button.y > 300)
    await m.tapOn({
      point: `${Math.round(button.x + button.w / 2)},${Math.round(button.y + button.h / 2)}`
    })
  await settle(5000)
  check(await onScreen(/^Your Home$/), `signed in as the ${who}`)
}
async function signOut(): Promise<void> {
  await tap('Account, .*')
  for (let page = 0; page < 3; page++) await m.scroll({ direction: 'DOWN' })
  await tap('Sign out')
  await settle(3000)
  check(await onScreen(/^Sign in to TeamStation$/), 'signed out')
}

async function openRosters(): Promise<void> {
  await tap('Schedule')
  await tap('Lakeside Herons @ Ridgeview Falcons.*')
  await tap('Score')
  await tap('Full game scoring')
  await settle(3000)
  await tap('Open scoring menu')
  await tap('Set Team Rosters')
}

async function n1(): Promise<void> {
  console.log('N1 Set Team Rosters')
  await openRosters()
  await tap('Home Team')
  check(await onScreen(/^Roster$/), 'opened on the Roster tab')
  await shot('set-rosters-open-after')
  await m.scrollUntilVisible({ element: { text: 'Add Existing Player' } })
  await shot('roster-bottom-after')
  await tap('Add Existing Player')
  await m.assertVisible({ text: 'Choose Aaron J', timeout: 15000 })
  // Each card is one control to VoiceOver; its pills show in the shot.
  await shot('existing-player-list')
  await tap('Search players')
  check(
    (await labels()).some(node => /^Search players$/.test(node.label)),
    'the search field is focused above the keyboard'
  )
  // The scoring caret is the surface's accent.
  await caretShot('existing-player-keyboard', [[52, 211, 153]])
  await m.inputText({ text: 'bet' })
  await m.assertVisible({ text: 'Choose Mookie B', timeout: 15000 })
  await m.hideKeyboard()
  await tap('Choose Mookie B')
  check(await onScreen(/^Add to Roster$/), 'Add to Roster opened')
  check(await onScreen(/^Add as Pool Player$/), 'the pool action is offered')
  await shot('add-to-roster-sheet')
  await tap('Jersey Number')
  await m.inputText({ text: '50' })
  await m.hideKeyboard()
  await tap('Add to Roster')
  await m.assertVisible({
    text: '.*Their guardians were notified.*',
    timeout: 15000
  })
  check(
    await onScreen(/^Mookie B, jersey 50/),
    'Betts is on the Falcons with #50'
  )
  await shot('added-roster-player')
  await tap('Away Team')
  await m.scrollUntilVisible({ element: { text: 'Add Existing Player' } })
  await tap('Add Existing Player')
  await tap('Search players')
  await m.inputText({ text: 'freeman' })
  await m.assertVisible({ text: 'Choose Freddie F', timeout: 15000 })
  await m.hideKeyboard()
  await tap('Choose Freddie F')
  check(
    !(await onScreen(/^Add to Roster$/)) ||
      (await onScreen(/^Add as Pool Player$/)),
    'the Herons offer the pool'
  )
  await tap('Add as Pool Player')
  await m.assertVisible({ text: '.*Freddie F was added.*', timeout: 15000 })
  check(await onScreen(/game-only player/), 'Freeman is a game-only player')
  await shot('added-pool-player')
  await tap('Save Rosters')
  await settle(3000)
  await tap('Open scoring menu')
  await tap('Set Team Rosters')
  // Reopened, the roster reads full names to a roster manager.
  await tap('Home Team')
  check(
    await onScreen(/^Mookie B\w*, jersey 50/),
    'Betts stays on the Falcons after the save'
  )
  await tap('Away Team')
  check(
    await onScreen(/^Freddie F, .*game-only player/),
    'Freeman stays on the Herons after the save'
  )
  await tap('Cancel')
}

/** Out of scoring, or anywhere else, to the app's tabs. */
async function home(): Promise<void> {
  await m.launchApp({ appId: APP_ID, stopApp: true })
  await settle(3000)
}
/** From Home to the Falcons' team settings. */
async function openFalconsSettings(): Promise<void> {
  await home()
  await tap('Home')
  await tap('Ridgeview Falcons')
  await settle(3000)
  await tap('Manage')
  await m.scrollUntilVisible({ element: { text: 'Create Player' } })
}

async function n2(): Promise<void> {
  console.log('N2 team settings')
  await openFalconsSettings()
  for (const row of ['Add Person to Team', 'Create Invite Link', 'Add Player'])
    check(await onScreen(new RegExp(`^${row}`)), `Team management lists ${row}`)
  // Clear of the floating tab bar, all four rows in the shot.
  await m.scroll({ direction: 'DOWN' })
  await shot('team-management-after')
  await tap('Create Player')
  await m.assertVisible({ text: 'First name', timeout: 15000 })
  await shot('team-create-player')
  await tap('First name')
  await m.inputText({ text: 'Walker' })
  await tap('Last name')
  await m.inputText({ text: 'Buehler' })
  await m.hideKeyboard()
  await tap('Player position P')
  await tap('Create Player and Add Another')
  await m.assertVisible({ text: '.*Created Walker Buehler.*', timeout: 15000 })
  check(
    !(await labels()).some(node => node.label === 'Walker'),
    'the form starts again, empty'
  )
  await tap('Back')
  await m.scrollUntilVisible({ element: { text: 'Add Player' } })
  await tap('Add Player')
  await tap('Search players')
  // The app theme's caret is the system's blue.
  await caretShot('team-add-player-keyboard', [[67, 107, 240]])
  await m.inputText({ text: 'burn' })
  await m.assertVisible({ text: 'Choose Corbin B', timeout: 15000 })
  await m.hideKeyboard()
  await tap('Choose Corbin B')
  check(await onScreen(/^Add to Roster$/), 'Add to Roster opened')
  check(!(await onScreen(/^Add as Pool Player$/)), 'no pool player in settings')
  await shot('team-add-to-roster')
  await tap('Add to Roster')
  await m.assertVisible({
    text: '.*Added Corbin B to the roster.*',
    timeout: 15000
  })
}

async function n3(): Promise<void> {
  console.log('N3 Player Settings')
  await home()
  await tap('Home')
  await tap('Ridgeview Falcons')
  await settle(3000)
  await tap('Team')
  await m.scrollUntilVisible({ element: { text: 'Clayton K.*' } })
  await tap('Clayton K.*')
  await settle(3000)
  await tap('Player settings')
  await m.assertVisible({ text: 'Throws Right', timeout: 15000 })
  // The form's Save, clear of the floating tab bar.
  await m.scroll({ direction: 'DOWN' })
  await shot('player-settings-after')
  await tap('Throws Right')
  await tap('Save')
  await m.assertVisible({ text: 'Saved.', timeout: 15000 })
}

async function n4(): Promise<void> {
  console.log("N4 the guardian's Reject")
  await signIn('guardian')
  await tap('Notifications')
  await m.assertVisible({ text: 'Reject .*', timeout: 15000 })
  await shot('guardian-notice')
  await tap('Reject .*')
  await settle(3000)
  check(!(await onScreen(/^Reject /)), 'the notice is decided')
  await signIn('coach')
  await openRosters()
  await tap('Home Team')
  check(
    !(await onScreen(/^Mookie B\w*, jersey 50/)),
    'Betts is off the Falcons'
  )
  await tap('Cancel')
}

/**
 * Team settings open (SETTINGS) and then the API stopped by the caller:
 * Add Player says why it is empty.
 */
async function offline(): Promise<void> {
  console.log('OFFLINE Add Player with no server')
  await m.scrollUntilVisible({ element: { text: 'Add Player' } })
  await tap('Add Player')
  await m.assertVisible({
    text: 'Searching needs a connection.',
    timeout: 30000
  })
  await shot('team-add-player-offline')
  await tap('Cancel')
}

async function main(): Promise<void> {
  mkdirSync(ARTIFACTS!, { recursive: true })
  const daemon = await MaestroD.connect({
    name: process.env.MAESTRO_D ?? 'existingPlayerNative',
    spawn: true
  })
  try {
    m = await daemon.attach({
      device: UDID,
      platform: 'ios',
      appId: APP_ID,
      teamId: process.env.TS_E2E_TEAM_ID
    })
  } catch (error) {
    if ((error as { code?: string }).code !== 'DEVICE_IN_USE') throw error
    m = daemon.device(UDID)
  }
  const asked = process.argv.slice(2)
  const run = (name: string): boolean =>
    asked.length === 0 || asked.includes(name)
  if (run('N1') || run('N2') || run('N3')) await signIn('coach')
  if (run('N1')) await n1()
  if (run('N2')) await n2()
  if (run('N3')) await n3()
  if (run('N4')) await n4()
  // Only when asked: OFFLINE needs the API stopped after SETTINGS.
  if (asked.includes('SETTINGS')) await openFalconsSettings()
  if (asked.includes('OFFLINE')) await offline()
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
