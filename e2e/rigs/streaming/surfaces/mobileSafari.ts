import { findPicture, readClock, type TileClock } from '../clockReader'
import { type HierarchyNode, readPagePlayer } from './hierarchy'
import { decodePng, type Rect, regionAdvancing } from './regions'
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

/** How many times the page's player is looked at, and tapped if still, when it is joined. */
const START_TRIES = 3

/** How long the full-screen pill covers the picture's top. */
const PILL_MS = 2500

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
    await this.startPicture()
  }

  /** Actions so far: every other one is in full screen. */
  private actions = 0

  private async pagePlayer(): Promise<
    NonNullable<ReturnType<typeof readPagePlayer>>
  > {
    const player = readPagePlayer(
      (await this.device.hierarchy()) as HierarchyNode
    )
    if (player == null)
      throw new Error(`${this.name}: the game page's player is not up`)
    return player
  }

  /** Shows the player's controls, by a touch on its bottom-left, which neither pauses nor seeks. */
  private async reveal(area: Rect): Promise<void> {
    await this.device.tapOn({
      point: `${Math.round(area.x + 30)},${Math.round(area.y + area.height - 30)}`
    })
  }

  private async press(button: Rect): Promise<void> {
    await this.device.tapOn({
      point: `${Math.round(button.x + button.width / 2)},${Math.round(button.y + button.height / 2)}`
    })
  }

  /**
   * Every other action happens in full screen: entered before it, left before
   * the next, so scrubbing and Jump to present are tried both on the page and
   * full screen. Where it is now is read from its full-screen button each
   * time: a relaunch opens it on the page, and Safari can leave full screen
   * on its own.
   */
  private async alternate(): Promise<void> {
    const wantFull = this.actions++ % 2 === 1
    const player = await this.pagePlayer()
    if (player.fullScreen == null || player.isFullScreen === wantFull) return
    await this.reveal(player.area)
    await this.press(player.fullScreen)
    await this.sleep(1500)
  }

  /** A tap on the line at `fraction`, the controls shown just before: they hide again in a moment. */
  async scrub(fraction: number): Promise<void> {
    if (this.safari.angle == null) {
      await super.scrub(fraction)
      return
    }
    await this.alternate()
    await this.scrubHere(fraction)
  }

  /** Several scrubs in one place, page or full screen, as one action. */
  async rapidScrub(fractions: number[], intervalMs = 1000): Promise<void> {
    if (this.safari.angle == null) {
      await super.rapidScrub(fractions, intervalMs)
      return
    }
    await this.alternate()
    for (const [index, fraction] of fractions.entries()) {
      if (index > 0) await this.sleep(intervalMs)
      await this.scrubHere(fraction)
    }
  }

  private async scrubHere(fraction: number): Promise<void> {
    const player = await this.pagePlayer()
    const { from, to, y } = player.line
    const x = from + (to - from) * Math.max(0, Math.min(1, fraction))
    await this.reveal(player.area)
    await this.device.tapOn({ point: `${Math.round(x)},${y}` })
  }

  async jumpToPresent(): Promise<void> {
    if (this.safari.angle == null) {
      await super.jumpToPresent()
      return
    }
    await this.alternate()
    const player = await this.pagePlayer()
    if (player.jump == null)
      throw new Error(`${this.name}: the player shows no Jump to present`)
    await this.reveal(player.area)
    await this.press(player.jump)
  }

  /**
   * Starts the game page's player when it stands still. A page reached by its
   * address may show its first picture and wait, or start on its own, muted,
   * a moment later (a live game opened at its Videos): a tap on the picture
   * starts one and pauses the other. So it taps only a picture that stands
   * still, then looks again: a tap that caught a player just starting, and
   * paused it, is undone by the next.
   */
  private async startPicture(): Promise<void> {
    const shot = async (): Promise<ReturnType<typeof decodePng>> =>
      decodePng(await this.device.screenshot())
    for (let attempt = 0; attempt < START_TRIES; attempt++) {
      const first = await shot()
      const place = findPicture(first)
      if (place == null) return
      await this.sleep(1500)
      const before = readClock(first, place)
      const after = readClock(await shot(), place)
      if (before == null || before.msOfDay !== after?.msOfDay) return
      const x = ((place.x + place.w / 2) / first.width) * 100
      const y = ((place.y + place.h / 2) / first.height) * 100
      await this.device.tapOn({ point: `${x.toFixed(1)}%,${y.toFixed(1)}%` })
      await tapIfShown(this.device, { text: LABELS.tapForSound }, 2000)
      await this.sleep(1500)
    }
  }

  async probe(): Promise<SurfaceProbe> {
    const angle = this.safari.angle
    if (angle == null) return await super.probe()
    let first: Uint8Array
    let second: Uint8Array
    try {
      first = await this.device.screenshot()
      // Entering full screen, the page's "Swipe up for full screen" pill
      // sits over the picture's top for a moment, and the picture is not
      // found: it is looked for again once the pill has gone.
      if (findPicture(decodePng(first)) == null) {
        await this.sleep(PILL_MS)
        first = await this.device.screenshot()
      }
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
    // The clock decides wherever both frames read one. Two sure readings
    // are compared as they are. An uncertain one (a digit under the player's
    // controls, read as 0) is trusted only for an answer it can give: the
    // same reading is a picture standing still, though the controls change
    // its pixels; a step the size a playing clock makes between the frames
    // is a picture moving; anything else is not known. A clock read in one
    // frame and missing from the other is a picture going or coming (a
    // frozen frame, then black while the player reloads): not known either.
    // The pixels decide only when neither frame reads a clock.
    const gapMs = this.options.frameGapMs ?? 2000
    const sure = (reading: TileClock['reading']): boolean =>
      reading != null && reading.confidence >= 1
    const advancing =
      before != null && after != null
        ? sure(before) && sure(after)
          ? after.msOfDay !== before.msOfDay
          : after.msOfDay === before.msOfDay
            ? false
            : after.msOfDay - before.msOfDay >= 500 &&
                after.msOfDay - before.msOfDay <= gapMs * 3
              ? true
              : null
        : before != null || after != null
          ? null
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
