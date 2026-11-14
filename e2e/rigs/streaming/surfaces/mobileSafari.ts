import {
  type ClockReading,
  findPicture,
  MIN_CONFIDENCE,
  readClock,
  type TileClock
} from '../clockReader'
import { decodePng, regionAdvancing } from './regions'
import { LABELS, type SurfaceProbe, tapIfShown } from './surface'
import { type TouchOptions, TouchSurface } from './touch'

export const SAFARI = 'com.apple.mobilesafari'

/**
 * The web app in Safari on the iPhone. It opens the game's multi-angle address in a new
 * tab the first time, through Safari's address field so the installed app cannot claim
 * the link, and brings that tab back afterwards. A relaunch closes the tab and opens
 * the address again; the sign-in is Safari's and survives it.
 */
export interface MobileSafariOptions extends Omit<TouchOptions, 'appId'> {
  /** The game page on the web app. */
  gameUrl: string
  appId?: string
  /**
   * Watch this one camera in the game page's own player, picked from the
   * camera pills, instead of all the angles at once. The page names no
   * bounds for that player, so it is found on the screenshot by the frame's
   * burned-in ink (`findPicture`).
   */
  angle?: string
}

export class MobileSafariSurface extends TouchSurface {
  private opened = false
  private pictures = 0

  constructor(private readonly safari: MobileSafariOptions) {
    super({ ...safari, appId: safari.appId ?? SAFARI })
  }

  private async typeAddress(): Promise<void> {
    await tapIfShown(this.device, { id: 'TabBarItemTitle' }, 3000)
    await tapIfShown(this.device, { id: 'URL' }, 3000)
    await this.device.inputText(this.safari.gameUrl)
    await this.device.pressKey('Enter')
  }

  /** A new tab with the game in it. */
  protected async openGame(): Promise<void> {
    await this.device.launchApp({ appId: this.options.appId, stopApp: false })
    await tapIfShown(this.device, { id: 'TabOverviewButton' }, 3000)
    await tapIfShown(this.device, { id: 'NewTabButton' }, 3000)
    await this.typeAddress()
    this.opened = true
  }

  protected async openAngles(): Promise<void> {
    const angle = this.safari.angle
    if (angle == null) {
      await super.openAngles()
      return
    }
    // Upright: in landscape the page's pinned tabs cover the top of its
    // player, where the clock is, at every scroll that shows its pills.
    await this.device.setOrientation({ orientation: 'PORTRAIT' })
    await this.device.scrollUntilVisible({
      element: { text: angle },
      direction: 'DOWN',
      timeout: 15000
    })
    await this.device.tapOn({ text: angle, timeout: 15000 })
    // Sound needs a tap on a phone's browser.
    await tapIfShown(this.device, { text: LABELS.tapForSound }, 2000)
  }

  async probe(): Promise<SurfaceProbe> {
    const angle = this.safari.angle
    if (angle == null) return await super.probe()
    let first: Uint8Array
    let second: Uint8Array
    try {
      first = await this.device.screenshot()
      await this.sleep(this.options.frameGapMs ?? 2000)
      second = await this.device.screenshot()
    } catch (error) {
      return {
        tiles: null,
        bar: null,
        foreground: null,
        reason: `${this.name}: ${(error as Error).message}`
      }
    }
    const foreground = await this.foreground().catch(() => null)
    const screenshots =
      this.options.saveShot == null
        ? []
        : [
            this.options.saveShot(
              `${this.name}-${++this.pictures}-a.png`,
              first
            ),
            this.options.saveShot(`${this.name}-${this.pictures}-b.png`, second)
          ]
    const a = decodePng(first)
    const place = findPicture(a)
    if (place == null) {
      return {
        tiles: [],
        bar: null,
        foreground,
        reason: `${this.name}: no picture of ${angle} on screen`,
        screenshots
      }
    }
    // Moving is the clock moving: between two frames of a synthetic camera
    // little but its digits change, under the noise a whole picture's
    // difference allows. The pixels decide only where a clock cannot be read.
    const b = decodePng(second)
    const before = readClock(a, place)
    const after = readClock(b, place)
    const readable = (reading: ClockReading | null): reading is ClockReading =>
      reading != null && reading.confidence >= MIN_CONFIDENCE
    const advancing =
      readable(before) && readable(after)
        ? after.msOfDay !== before.msOfDay
        : regionAdvancing(
            a,
            b,
            { x: place.x, y: place.y, width: place.w, height: place.h },
            1
          )
    return {
      tiles: [{ angle, advancing, notice: null }],
      bar: null,
      foreground,
      screenshots
    }
  }

  async readClocks(): Promise<TileClock[]> {
    const angle = this.safari.angle
    if (angle == null) return await super.readClocks()
    const picture = decodePng(await this.device.screenshot())
    const place = findPicture(picture)
    return [
      { angle, reading: place == null ? null : readClock(picture, place) }
    ]
  }

  get hasTab(): boolean {
    return this.opened
  }

  /** Brings Safari, and the tab it was on, back to the front. */
  async resume(): Promise<void> {
    await this.device.launchApp({ appId: this.options.appId, stopApp: false })
  }

  async relaunch(): Promise<void> {
    await this.device.launchApp({ appId: this.options.appId, stopApp: false })
    await tapIfShown(this.device, { id: 'TabOverviewButton' }, 3000)
    await tapIfShown(this.device, { id: 'Close' }, 3000)
    await tapIfShown(this.device, { id: 'NewTabButton' }, 3000)
    await this.typeAddress()
    await this.openAngles()
  }
}
