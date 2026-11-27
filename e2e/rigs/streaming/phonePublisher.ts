import type { SoakPublisher } from './soakRun'
import type { HierarchyNode } from './surfaces/hierarchy'
import { realSleep, type Sleep } from './surfaces/surface'

/** What a publishing phone needs from maestro-d. */
export interface PublisherDevice {
  launchApp: (options: { appId: string; stopApp?: boolean }) => Promise<unknown>
  openLink: (options: { link: string }) => Promise<unknown>
  tapOn: (options: Record<string, unknown>) => Promise<unknown>
  inputText: (options: { text: string }) => Promise<unknown>
  eraseText: (options: { characters: number }) => Promise<unknown>
  assertVisible: (options: Record<string, unknown>) => Promise<unknown>
  swipe: (options: {
    startX: number
    startY: number
    endX: number
    endY: number
    duration?: number
  }) => Promise<unknown>
  hierarchy: () => Promise<HierarchyNode>
}

export interface PhonePublisherOptions {
  device: PublisherDevice
  appId: string
  /** The game's watch tab, as a link the app opens. */
  gameLink: string
  /** The camera's name: PhoneA or PhoneB. */
  angle: string
  /** Hands a link to this app alone (`NativeAppOptions.openIn`). */
  openIn?: (link: string) => Promise<void>
  sleep?: Sleep
}

/** Every node of maestro-d's normalized hierarchy, depth first. */
export function flatten(node: HierarchyNode | undefined): HierarchyNode[] {
  if (node == null) return []
  return [node, ...(node.children ?? []).flatMap(flatten)]
}

/**
 * A phone filming the bench clock in TeamStation Develop, started and stopped
 * as a person would: the game's Record Video, the camera named for its angle,
 * the broadcast button, and Slide to Stop. Real publishers are never cut.
 */
export class PhonePublisher implements SoakPublisher {
  private readonly sleep: Sleep

  constructor(private readonly options: PhonePublisherOptions) {
    this.sleep = options.sleep ?? realSleep
  }

  private async visible(
    target: Record<string, unknown>,
    timeout: number
  ): Promise<boolean> {
    try {
      await this.options.device.assertVisible({ ...target, timeout })
      return true
    } catch {
      return false
    }
  }

  private async node(
    test: (node: HierarchyNode) => boolean
  ): Promise<HierarchyNode | undefined> {
    return flatten(await this.options.device.hierarchy()).find(test)
  }

  private async nameCamera(): Promise<void> {
    const { device, angle } = this.options
    const isNameInput = (node: HierarchyNode): boolean =>
      node.type === 'EditText' || node.type?.endsWith('TextField') === true
    const android = (await this.node(isNameInput))?.type === 'EditText'
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) await device.eraseText({ characters: angle.length + 4 })
      // Android sets the input's entire value on each call. The controlled
      // iOS field needs time to render between individual keystrokes.
      if (android) await device.inputText({ text: angle })
      else {
        for (const letter of angle) {
          await device.inputText({ text: letter })
          await this.sleep(180)
        }
      }
      const field = await this.node(isNameInput)
      if (field?.text === angle) return
      // On iOS the normalized text is the accessibility label. Match the
      // value on that same field through its accessibility identifier.
      if (
        field?.id != null &&
        field.id !== '' &&
        (await this.visible({ id: field.id, text: `^${angle}$` }, 1500))
      )
        return
    }
    throw new Error(
      `${angle}: the camera name field did not show the requested angle`
    )
  }

  async start(): Promise<void> {
    const { device, appId, gameLink, angle } = this.options
    if (this.options.openIn != null) {
      await this.options.openIn(gameLink)
    } else {
      await device.launchApp({ appId, stopApp: true })
      await device.openLink({ link: gameLink })
    }
    await this.sleep(2500)
    await device.tapOn({ text: 'Record Video' })
    if (await this.visible({ text: 'Name this camera angle' }, 15_000)) {
      await this.nameCamera()
      await device.tapOn({ text: 'Record with this phone' })
    }
    if (!(await this.visible({ id: 'broadcast-button' }, 20_000))) {
      throw new Error(`${angle}: the camera screen did not open`)
    }
    if (
      !(await this.visible({ id: 'camera-name', text: `^${angle}$` }, 5000))
    ) {
      throw new Error(`${angle}: the camera preview showed a different angle`)
    }
    await this.sleep(1000)
    await device.tapOn({ id: 'broadcast-button' })
    if (await this.visible({ text: 'Press record to start stream' }, 3000)) {
      throw new Error(`${angle}: the broadcast button did not start the stream`)
    }
  }

  async stop(): Promise<void> {
    const { device } = this.options
    await device.tapOn({ id: 'broadcast-button' })
    await this.sleep(1000)
    const knob = await this.node(node => node.id === 'slide-to-stop-knob')
    const track = await this.node(node => node.id === 'slide-to-stop-track')
    if (knob?.bounds != null && track?.bounds != null) {
      const y = Math.round(knob.bounds.y + knob.bounds.height / 2)
      await device.swipe({
        startX: Math.round(knob.bounds.x + knob.bounds.width / 2),
        startY: y,
        endX: Math.round(track.bounds.x + track.bounds.width - 4),
        endY: y,
        duration: 800
      })
    }
    if (
      !(await this.visible({ text: 'Press record to start stream' }, 20_000))
    ) {
      throw new Error(
        `${this.options.angle}: Slide to Stop did not stop the stream`
      )
    }
    await device.tapOn({ id: 'camera-close' })
  }
}
