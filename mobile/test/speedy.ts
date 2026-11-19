import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AttachedDevice } from './maestroD'

/**
 * TS Speedy's scenarios, shared by the iOS and Android scripts
 * (`mobile/apps/tsSpeedy/e2e/speedy.e2e.ts`, `mobile/apps/tsSpeedyAndroid/e2e/speedy.e2e.ts`).
 *
 * Readings come in through the app's UI-test links (`tsspeedy://test/…`), which deliver them as
 * the radar does, so no ball has to be in the air. The voice is checked through the black-on-black
 * `speedy-speech-log` text, which holds the last phrase handed to the player.
 */

export const APP_ID = 'app.teamstation.speedy'

export interface SpeedyHooks {
  /** Opens the app fresh with `uiTest` and clears any permission prompt in the way. */
  launch: () => Promise<void>
  /** The status Settings should show with nothing paired. */
  unpairedStatus: string
  /** Whether Pair can be tried here (a phone with Bluetooth). */
  canPair: boolean
  /** Called between E3b and E3c, while the app's speech capture holds E3 and E3b. */
  afterVoice?: () => Promise<void>
}

export function required(key: string): string {
  const value = process.env[key]
  if (value == null || value === '') throw new Error(`${key} is required`)
  return value
}

const log = (line: string): void => {
  console.log(`[${new Date().toISOString()}] ${line}`)
}

async function shows(
  m: AttachedDevice,
  selector: Record<string, unknown>,
  timeout = 3000
): Promise<boolean> {
  try {
    await m.extendedWaitUntil({ visible: selector, timeout })
    return true
  } catch {
    return false
  }
}

async function expectText(
  m: AttachedDevice,
  id: string,
  text: string,
  timeout = 5000
): Promise<void> {
  await m.extendedWaitUntil({ visible: { id, text }, timeout })
  log(`ok ${id} = ${text}`)
}

/** The log shows a phrase when it is handed to the player; this lets it finish being heard. */
async function letItPlay(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 2500))
}

async function link(m: AttachedDevice, command: string): Promise<void> {
  log(`link tsspeedy://test/${command}`)
  await m.openLink({ link: `tsspeedy://test/${command}` })
}

export async function runScenarios(
  m: AttachedDevice,
  hooks: SpeedyHooks,
  prefix: string
): Promise<void> {
  log('E1 empty readout')
  await hooks.launch()
  await m.extendedWaitUntil({ visible: { id: 'speedy-pitch' }, timeout: 30000 })
  if (await shows(m, { id: 'speedy-audio-off' }, 1000))
    await m.tapOn({ id: 'speedy-audio-off' })
  await expectText(m, 'speedy-pitch', '--')
  await expectText(m, 'speedy-exit', '--')
  await m.assertVisible({ id: 'speedy-pair-hint' })
  await m.assertVisible({ id: 'speedy-settings' })
  await m.assertVisible({ id: 'speedy-audio-on' })
  await m.shot(`${prefix}-readout-empty`)

  log('E2 a pitch alone')
  await link(m, 'radar-feed?pitch=56&exit=0')
  await expectText(m, 'speedy-pitch', '56')
  await expectText(m, 'speedy-exit', '--')
  await expectText(m, 'speedy-speech-log', '56')
  await letItPlay()

  log('E2b another pitch once the first has played, with no reset between')
  await link(m, 'radar-feed?pitch=70&exit=0')
  await expectText(m, 'speedy-pitch', '70')
  await expectText(m, 'speedy-speech-log', '70')
  await letItPlay()

  log('E3 a pitch, then its exit 100 ms later')
  await link(m, 'reset')
  await link(m, 'radar-sequence?pitch=56&exit=52&gapMs=100')
  await expectText(m, 'speedy-pitch', '56')
  await expectText(m, 'speedy-exit', '52')
  await expectText(m, 'speedy-speech-log', '56 and 52 exit')
  await m.shot(`${prefix}-readout-pitch-exit`)
  await letItPlay()

  log('E3b an exit 600 ms after its pitch')
  await link(m, 'reset')
  await link(m, 'radar-sequence?pitch=61&exit=48&gapMs=600')
  await expectText(m, 'speedy-pitch', '61')
  await expectText(m, 'speedy-speech-log', '48 exit')
  await letItPlay()
  if (hooks.afterVoice != null) await hooks.afterVoice()

  log('E3c an exit alone, then a pitch out of range')
  await link(m, 'reset')
  await link(m, 'radar-feed?pitch=0&exit=53')
  await expectText(m, 'speedy-speech-log', '53 exit')
  await link(m, 'radar-feed?pitch=104&exit=0')
  await expectText(m, 'speedy-pitch', '104')
  await new Promise(resolve => setTimeout(resolve, 1000))
  await expectText(m, 'speedy-speech-log', '53 exit')
  await m.shot(`${prefix}-readout-three-digits`)

  log('E4 both sides expire five seconds after their reading')
  await link(m, 'reset')
  await link(m, 'radar-feed?pitch=56&exit=52')
  const fed = Date.now()
  await expectText(m, 'speedy-pitch', '56')
  await expectText(m, 'speedy-exit', '52')
  await new Promise(resolve =>
    setTimeout(resolve, Math.max(0, fed + 4500 - Date.now()))
  )
  await expectText(m, 'speedy-pitch', '56', 500)
  // Gone at five seconds: the wait allows for the driver's own round trip, not a late redraw.
  await expectText(m, 'speedy-pitch', '--', 1500)
  await expectText(m, 'speedy-exit', '--', 500)
  log(
    `ok both dashes ${((Date.now() - fed) / 1000).toFixed(2)} s after the reading`
  )
  await m.shot(`${prefix}-readout-expired`)

  log('E5 audio off')
  await link(m, 'reset')
  await m.tapOn({ id: 'speedy-audio-on' })
  await m.assertVisible({ id: 'speedy-audio-off' })
  await link(m, 'radar-feed?pitch=70&exit=0')
  await expectText(m, 'speedy-pitch', '70')
  await expectText(m, 'speedy-speech-log', 'muted')
  await hooks.launch()
  await m.extendedWaitUntil({
    visible: { id: 'speedy-audio-off' },
    timeout: 30000
  })
  log('ok audio stays off after a relaunch')
  await m.tapOn({ id: 'speedy-audio-off' })
  await m.assertVisible({ id: 'speedy-audio-on' })

  log('E6 settings')
  await m.tapOn({ id: 'speedy-settings' })
  await m.assertVisible({ text: 'Radar' })
  if (
    hooks.canPair &&
    (await shows(
      m,
      { id: 'settings-radar-status', text: 'Bluetooth off' },
      2000
    ))
  ) {
    // The app reads Bluetooth itself; a phone left with it off is a bench problem, not a failure.
    throw new Error('Turn Bluetooth on on the test phone, then run again')
  }
  await expectText(m, 'settings-radar-status', hooks.unpairedStatus, 10000)
  await m.assertVisible({ id: 'settings-radar-pair' })
  await m.shot(`${prefix}-settings-unpaired`)
  if (hooks.canPair) {
    await m.tapOn({ id: 'settings-radar-pair' })
    await m.assertVisible({ id: 'settings-radar-close' })
    if (!(await shows(m, { id: 'settings-radar-option-ADFA.*' }, 5000))) {
      await m.assertVisible({ text: 'No radars in range' })
    }
    await m.shot(`${prefix}-settings-pairing`)
    await m.tapOn({ id: 'settings-radar-close' })
  } else {
    log('skip Pair: no Bluetooth here')
  }
  await m.tapOn({ id: 'settings-done' })
  await m.assertVisible({ id: 'speedy-pitch' })

  log('E6 portrait only')
  await link(m, 'radar-feed?pitch=56&exit=52')
  try {
    await m.setOrientation({ orientation: 'LANDSCAPE_LEFT' })
    log('turned the device to landscape')
  } catch (error) {
    // iOS refuses to turn a portrait-only app: that refusal is the behaviour under test.
    const reason = String((error as { reason?: string }).reason ?? error)
    if (!reason.includes('Unable To Rotate')) throw error
    log(`the device would not turn to landscape: ${reason}`)
  }
  await new Promise(resolve => setTimeout(resolve, 1500))
  await expectText(m, 'speedy-pitch', '56')
  await m.shot(`${prefix}-readout-landscape`)
  await m.setOrientation({ orientation: 'PORTRAIT' }).catch(() => {})
  log('all scenarios passed')
}

/**
 * The keep-awake check on a phone (F1): with the platform's screen timeout at its shortest, the
 * readout is still on screen well after it. `shorten` sets the timeout and answers how to put it
 * back; `awake` reports whether the phone is still awake, beyond the readout being visible.
 */
export async function keepAwake(
  m: AttachedDevice,
  hooks: SpeedyHooks,
  shorten: () => Promise<() => Promise<void>>,
  waitMs: number,
  awake: () => Promise<boolean>,
  awakeText: string
): Promise<void> {
  log('keep-awake: shortening the screen timeout')
  const restore = await shorten()
  try {
    await hooks.launch()
    await m.extendedWaitUntil({
      visible: { id: 'speedy-pitch' },
      timeout: 30000
    })
    await expectText(m, 'speedy-awake', awakeText)
    log(`keep-awake: waiting ${waitMs / 1000} s on the readout`)
    await new Promise(resolve => setTimeout(resolve, waitMs))
    if (!(await awake()))
      throw new Error('the screen went to sleep with TS Speedy open')
    await m.assertVisible({ id: 'speedy-pitch' })
    log(`keep-awake: still awake after ${waitMs / 1000} s`)
  } finally {
    await restore()
    log('keep-awake: screen timeout restored')
  }
}

const CLIPS = join(
  __dirname,
  '../apps/common/SpeedyVoice/Sources/SpeedyVoice/Clips'
)

/** The phrases E2 through E3b speak, in order, as their clips. */
export const VOICE_PHRASES = [
  ['n56-final'],
  ['n70-final'],
  ['n56-and', 'word-and', 'n52-exit', 'word-exit'],
  ['n61-final'],
  ['n48-exit', 'word-exit']
]

/** The 16-bit samples of a mono PCM WAV, walking its chunks. */
function wavSamples(bytes: Buffer): Int16Array {
  let offset = 12
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString('ascii', offset, offset + 4)
    const size = bytes.readUInt32LE(offset + 4)
    if (id === 'data') {
      const count = Math.min(size, bytes.length - offset - 8) >> 1
      const out = new Int16Array(count)
      for (let i = 0; i < count; i++)
        out[i] = bytes.readInt16LE(offset + 8 + i * 2)
      return out
    }
    offset += 8 + size + (size & 1)
  }
  throw new Error('no data chunk')
}

/** How many 10 ms windows at 24 kHz hold sound (RMS above -40 dBFS). */
function voicedWindows(samples: Int16Array): number {
  const window = 240
  const floor = 32768 * Math.pow(10, -40 / 20)
  let voiced = 0
  for (let start = 0; start + window <= samples.length; start += window) {
    let sum = 0
    for (let i = start; i < start + window; i++) sum += samples[i] * samples[i]
    if (Math.sqrt(sum / window) > floor) voiced++
  }
  return voiced
}

/**
 * Checks the app's own speech capture against what E2 through E3b should have played: its
 * sound must add up to at least 90% of the expected phrases' sound, so a phrase that was handed
 * to the player but never heard fails here even though the speech log shows it.
 */
export function checkVoice(capturePath: string): void {
  const expected = VOICE_PHRASES.flat().reduce(
    (sum, clip) =>
      sum + voicedWindows(wavSamples(readFileSync(join(CLIPS, `${clip}.wav`)))),
    0
  )
  const heard = voicedWindows(wavSamples(readFileSync(capturePath)))
  log(`voice: ${heard} sounding 10 ms windows captured, ${expected} expected`)
  if (heard < expected * 0.9) {
    throw new Error(
      `the app played only ${heard} of ${expected} expected sounding windows`
    )
  }
}
