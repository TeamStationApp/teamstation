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
}

export class MobileSafariSurface extends TouchSurface {
  private opened = false

  constructor(private readonly safari: MobileSafariOptions) {
    super({ ...safari, appId: safari.appId ?? SAFARI })
  }

  private async typeAddress(): Promise<void> {
    await this.device.tapOn({
      id: 'TabBarItemTitle',
      optional: true,
      timeout: 3000
    })
    await this.device.tapOn({ id: 'URL', optional: true, timeout: 3000 })
    await this.device.inputText(this.safari.gameUrl)
    await this.device.pressKey('Enter')
  }

  /** A new tab with the game in it. */
  protected async openGame(): Promise<void> {
    await this.device.launchApp({ appId: this.options.appId, stopApp: false })
    await this.device.tapOn({
      id: 'TabOverviewButton',
      optional: true,
      timeout: 3000
    })
    await this.device.tapOn({
      id: 'NewTabButton',
      optional: true,
      timeout: 3000
    })
    await this.typeAddress()
    this.opened = true
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
    await this.device.tapOn({
      id: 'TabOverviewButton',
      optional: true,
      timeout: 3000
    })
    await this.device.tapOn({
      id: 'closeTabButton',
      optional: true,
      timeout: 3000
    })
    await this.device.tapOn({
      id: 'NewTabButton',
      optional: true,
      timeout: 3000
    })
    await this.typeAddress()
    await this.openAngles()
  }
}
