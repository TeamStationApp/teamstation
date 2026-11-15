import { type TouchOptions, TouchSurface } from './touch'

/**
 * TeamStation Develop on a phone or tablet, or the iPhone's app half. It opens the game
 * by its link, which the app claims, and relaunches by force-closing and launching
 * again, keeping its sign-in.
 */
export interface NativeAppOptions extends TouchOptions {
  /** The game's address, which the installed app opens. */
  gameLink: string
  /**
   * Hands a link to this app alone. Another installed TeamStation app can claim
   * the same scheme, and the system may give the link to that one instead.
   */
  openIn?: (link: string) => Promise<void>
}

export class NativeAppSurface extends TouchSurface {
  constructor(private readonly app: NativeAppOptions) {
    super(app)
  }

  protected async openGame(): Promise<void> {
    if (this.app.openIn != null) {
      await this.app.openIn(this.app.gameLink)
      return
    }
    await this.device.launchApp({ appId: this.app.appId, stopApp: false })
    await this.device.openLink({ link: this.app.gameLink })
  }

  async relaunch(): Promise<void> {
    await this.device.stopApp({ appId: this.app.appId })
    await this.join()
  }

  /** Brings the app back to the front without restarting it. */
  async resume(): Promise<void> {
    await this.device.launchApp({ appId: this.app.appId, stopApp: false })
  }
}
