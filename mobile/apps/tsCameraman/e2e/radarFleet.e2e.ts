import { attach, type AttachedDevice } from '../../../test/maestroD'

/**
 * TS Cameraman on iOS pairs a TAG One through the radar fleet and broadcasts with it (E2).
 *
 * Run Cameraman on the phone (`build-device.sh`), with a TAG One switched on and in range, then:
 *
 *   MAESTRO_D=radar-fleet-cameraman \
 *   CAMERAMAN_DEVICE_UDID=<udid> [MAESTRO_D_TEAM_ID=<team>] \
 *   E2E_ARTIFACT_DIR=<where the screenshots go> \
 *     node -r sucrase/register mobile/apps/tsCameraman/e2e/radarFleet.e2e.ts
 *
 * Settings turns the radar on, drops any earlier pairing, pairs the first radar in range and waits
 * for it to say Connected with its battery in the readout; then the camera starts broadcasting.
 */

const APP_ID = 'app.teamstation.cameraman'

function required(key: string): string {
  const value = process.env[key]
  if (value == null || value === '') throw new Error(`${key} is required`)
  return value
}

/** Whether `selector` shows up within `timeout`, without failing the run when it does not. */
async function shows(m: AttachedDevice, selector: Record<string, unknown>, timeout = 3000): Promise<boolean> {
  try {
    await m.extendedWaitUntil({ visible: selector, timeout })
    return true
  } catch {
    return false
  }
}

/**
 * Swipes the left column of Settings up until `selector` is on screen. In landscape Settings is
 * two columns and the Radar card is at the foot of the left one, which a swipe down the middle of
 * the screen never moves; in portrait the left column is the whole sheet.
 */
async function scrollLeftColumnTo(m: AttachedDevice, selector: Record<string, unknown>, swipes = 8): Promise<void> {
  for (let swipe = 0; swipe < swipes; swipe++) {
    if (await shows(m, selector, 1000)) return
    await m.swipe({ start: '25%, 80%', end: '25%, 30%', duration: 400 })
  }
  await m.assertVisible(selector)
}

async function main(): Promise<void> {
  const m = await attach({
    daemon: required('MAESTRO_D'),
    device: process.env.CAMERAMAN_DEVICE_UDID,
    appId: APP_ID
  })
  try {
    await m.launchApp({ appId: APP_ID, stopApp: true })
    await m.extendedWaitUntil({ visible: { id: 'settings-button' }, timeout: 30000 })
    await m.tapOn({ id: 'settings-button' })
    await scrollLeftColumnTo(m, { id: 'settings-radar-enabled' })
    // Off, the card shows neither Pair nor Unpair. A SwiftUI toggle does not report `checked` to
    // the driver, so the card's own controls say whether the radar is on.
    if (!(await shows(m, { id: 'settings-radar-pair' }, 1000)) && !(await shows(m, { id: 'settings-radar-unpair' }, 1000))) {
      await m.tapOn({ id: 'settings-radar-enabled' })
      // The first time on, iOS asks for Bluetooth.
      await m.tapOn({ text: 'Allow', optional: true, timeout: 5000 })
      await scrollLeftColumnTo(m, { id: 'settings-radar-(pair|unpair)' })
    }
    if (await shows(m, { id: 'settings-radar-unpair' })) {
      await m.tapOn({ id: 'settings-radar-unpair' })
    }
    await m.tapOn({ id: 'settings-radar-pair' })
    await m.extendedWaitUntil({ visible: { id: 'settings-radar-option-ADFA.*' }, timeout: 30000 })
    await m.tapOn({ id: 'settings-radar-option-ADFA.*' })
    // The paired radar's row is the card's last; bring its status on screen before waiting on it.
    await scrollLeftColumnTo(m, { id: 'settings-radar-status' })
    await m.extendedWaitUntil({ visible: { id: 'settings-radar-status', text: 'Connected' }, timeout: 60000 })
    await m.extendedWaitUntil({ visible: { id: 'settings-radar-speeds', text: '⚡\\d+% .*' }, timeout: 30000 })
    await m.shot('cameraman-ios-radar-connected')
    await m.tapOn({ id: 'settings-done' })

    await m.tapOn({ id: 'broadcast-button' })
    await m.extendedWaitUntil({ visible: { id: 'broadcasting-pill' }, timeout: 30000 })
    await m.assertVisible({ id: 'radar-speeds' })
    await m.shot('cameraman-ios-radar-broadcasting')
    console.log('the radar paired through the fleet, connected with its battery, and the camera is broadcasting')
  } finally {
    await m.detach()
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
