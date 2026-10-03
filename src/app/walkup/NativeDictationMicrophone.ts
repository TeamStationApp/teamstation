import type { CodegenTypes, TurboModule } from 'react-native'
import { TurboModuleRegistry } from 'react-native'

// The `DictationMicrophone` TurboModule's codegen spec. It lives beside
// `NativeWalkUpMusic` because this package's codegen reads one directory.
// iOS is ios/TeamStation/DictationMicrophone/. Android is
// android/.../walkup/DictationMicrophoneModule.kt. Both emit 16 kHz mono
// 16-bit PCM as base64 `onPcm` events.

export interface PcmEvent {
  pcm: string
}

export interface Spec extends TurboModule {
  readonly onPcm: CodegenTypes.EventEmitter<PcmEvent>
  start: () => Promise<void>
  stop: () => Promise<void>
}

export default TurboModuleRegistry.getEnforcing<Spec>('DictationMicrophone')
