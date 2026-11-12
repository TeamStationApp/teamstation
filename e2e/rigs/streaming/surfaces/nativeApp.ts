import { type TouchOptions, TouchSurface } from './touch'

/**
 * TeamStation Develop on a phone or tablet, or the iPhone's app half. It opens the game
 * by its link, which the app claims, and relaunches by force-closing and launching
 * again, keeping its sign-in.
 */
export interface NativeAppOptions extends TouchOptions {
  /** The game's address, which the installed app opens. */
  gameLink: string
}

export class NativeAppSurface extends TouchSurface {
  constructor(private readonly app: NativeAppOptions) {
    super(app)
  }

  protected async openGame(): Promise<void> {
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
