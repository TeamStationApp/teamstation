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
export function makeOpenMicrophone(module: PcmModule): OpenMicrophone {
  return async (onPcm, onEnded) => {
    let rest = new Uint8Array(0)
    const subscription = module.onPcm(event => {
      if (event.error != null && event.error !== '') {
        onEnded?.(event.error)
        return
      }
      if (event.pcm == null || event.pcm === '') return
      const taken = appendPcm(rest, bytesFromBase64(event.pcm))
      rest = taken.rest
      for (const frame of taken.frames) onPcm(frame)
    })
    try {
      await module.start()
    } catch (error) {
      subscription.remove()
      throw error
    }
    return {
      stop(): void {
        subscription.remove()
        module.stop()
      }
    }
  }
}

function loadNative(): PcmModule {
  return require('../walkup/NativeDictationMicrophone').default as PcmModule
}

/** Opens the phone's microphone. Tests pass a module and never reach this. */
export async function openPhoneMicrophone(
  onPcm: (pcm: ArrayBuffer) => void,
  module?: PcmModule
): Promise<Microphone> {
  return await makeOpenMicrophone(module ?? loadNative())(onPcm)
}

export const openMicrophone: OpenMicrophone = async onPcm =>
  await openPhoneMicrophone(onPcm)
