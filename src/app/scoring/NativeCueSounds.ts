import type { CodegenTypes, TurboModule } from 'react-native'
import { TurboModuleRegistry } from 'react-native'

// The `CueSounds` TurboModule's codegen spec (TeamStationWalkUpMusicSpec):
// ios/TeamStation/RCTCueSounds.mm and android/.../app/cues/. Every method is
// one platform call; what to call and when is cueSoundsController.ts.
export interface Spec extends TurboModule {
  load: (
    kind: string,
    samples: readonly CodegenTypes.Double[],
    sampleRate: CodegenTypes.Double
  ) => void
  play: (kind: string, voice: CodegenTypes.Double) => void
  stop: () => void
  isRunning: () => boolean
  start: () => void
  sessionCategory: () => string
  useAmbientSession: () => void
}
export default TurboModuleRegistry.get<Spec>('CueSounds')
