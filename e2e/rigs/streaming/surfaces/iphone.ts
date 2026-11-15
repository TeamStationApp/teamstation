import type { MaestroDevice } from '../../../core/maestro'
import type { MobileSafariSurface } from './mobileSafari'
import type { NativeAppSurface } from './nativeApp'
import {
  realSleep,
  type Sleep,
  type SoakSurfaceDriver,
  type SurfaceProbe
} from './surface'

export type IphoneFront = 'app' | 'safari'

/**
 * The iPhone watcher: the TeamStation app and Safari on one phone, one in front at a
 * time. Every action goes to the one in front. `switchTo` goes through the Home screen,
 * so the one left behind goes to the background as a viewer's would; the first switch
 * to Safari opens the game in a new tab, later ones bring that tab back.
 */
export interface IphoneOptions {
  device: MaestroDevice
  app: NativeAppSurface
  safari: MobileSafariSurface
  sleep?: Sleep
  /** How long the Home screen shows before the other app opens. */
  homeMs?: number
}

export class IphoneSurface implements SoakSurfaceDriver {
  readonly name = 'iphone'
  front: IphoneFront = 'app'
  private readonly sleep: Sleep

  constructor(private readonly options: IphoneOptions) {
    this.sleep = options.sleep ?? realSleep
  }

  /** The surface in front, by its soak name. */
  get surface(): 'iphone-app' | 'iphone-safari' {
    return this.front === 'app' ? 'iphone-app' : 'iphone-safari'
  }

  private current(): SoakSurfaceDriver {
    return this.front === 'app' ? this.options.app : this.options.safari
  }

  async switchTo(to: IphoneFront): Promise<{ newTab: boolean }> {
    if (to === this.front) return { newTab: false }
    await this.options.device.pressKey('HOME')
    await this.sleep(this.options.homeMs ?? 1500)
    let newTab = false
    if (to === 'app') await this.options.app.resume()
    else if (this.options.safari.hasTab) await this.options.safari.resume()
    else {
      await this.options.safari.join()
      newTab = true
    }
    this.front = to
    return { newTab }
  }

  async join(): Promise<void> {
    await this.current().join()
  }

  async cut(angle: string): Promise<void> {
    await this.current().cut(angle)
  }

  async scrub(fraction: number): Promise<void> {
    await this.current().scrub(fraction)
  }

  async rapidScrub(fractions: number[], intervalMs?: number): Promise<void> {
    await this.current().rapidScrub(fractions, intervalMs)
  }

  async skip(steps?: number[]): Promise<void> {
    await this.current().skip(steps)
  }

  async slowMotion(holdMs: number): Promise<void> {
    await this.current().slowMotion(holdMs)
  }

  async jumpToPresent(): Promise<void> {
    await this.current().jumpToPresent()
  }

  async exitAndReenter(waitMs?: number): Promise<void> {
    await this.current().exitAndReenter(waitMs)
  }

  async relaunch(): Promise<void> {
    await this.current().relaunch()
  }

  async probe(): Promise<SurfaceProbe> {
    return await this.current().probe()
  }
}
