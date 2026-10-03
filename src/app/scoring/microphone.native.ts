import type { Microphone, OpenMicrophone } from './dictationTypes'
import { appendPcm, bytesFromBase64 } from './pcmFrames'

/** The native module, as the opener uses it. A test hands in its own. */
export interface PcmModule {
  start: () => Promise<void>
  stop: () => void
  onPcm: (
    listener: (event: { pcm?: string; error?: string }) => void
  ) => { remove: () => void }
}

/**
 * The phone microphone as 16 kHz mono 16-bit PCM, the same frames the web
 * worklet posts. iOS and Android both expose `DictationMicrophone`, and both
 * already emit 3200-byte frames. A short leftover is still joined here, so a
 * frame that arrives split is sent whole.
 */
/** How many opens of this module are still listening. The module is one recorder. */
const occupancyOf = new WeakMap<PcmModule, { listeners: number }>()

function occupancy(module: PcmModule): { listeners: number } {
  const found = occupancyOf.get(module)
  if (found != null) return found
  const created = { listeners: 0 }
  occupancyOf.set(module, created)
  return created
}

/**
 * Drops this open's listener. The recorder stops when the last listener is
 * gone, so an open that lost the race does not silence the one that won.
 */
function releaseListener(
  module: PcmModule,
  subscription: { remove: () => void }
): void {
  subscription.remove()
  const count = occupancy(module)
  count.listeners -= 1
  if (count.listeners > 0) return
  count.listeners = 0
  module.stop()
}

export function makeOpenMicrophone(module: PcmModule): OpenMicrophone {
  return async (onPcm, onEnded) => {
    const count = occupancy(module)
    count.listeners += 1
    let rest = new Uint8Array(0)
    let released = false
    const subscription = module.onPcm(event => {
      if (released) return
      if (event.error != null && event.error !== '') {
        onEnded?.(event.error)
        return
      }
      if (event.pcm == null || event.pcm === '') return
      const taken = appendPcm(rest, bytesFromBase64(event.pcm))
      rest = taken.rest
      for (const frame of taken.frames) onPcm(frame)
    })
    const release = (): void => {
      if (released) return
      released = true
      releaseListener(module, subscription)
    }
    try {
      await module.start()
    } catch (error) {
      release()
      throw error
    }
    return { stop: release }
  }
}

function loadNative(): PcmModule {
  return require('../walkup/NativeDictationMicrophone').default as PcmModule
}

/** Opens the phone's microphone. Tests pass a module and never reach the require. */
export async function openPhoneMicrophone(
  onPcm: (pcm: ArrayBuffer) => void,
  module?: PcmModule,
  onEnded?: (message: string) => void
): Promise<Microphone> {
  return await makeOpenMicrophone(module ?? loadNative())(onPcm, onEnded)
}

export const openMicrophone: OpenMicrophone = async (onPcm, onEnded) =>
  await openPhoneMicrophone(onPcm, undefined, onEnded)
