import type { CodegenTypes, TurboModule } from 'react-native'
import { TurboModuleRegistry } from 'react-native'

/** Codegen contract; the caller performs the optional lookup inside its guard. */
export interface Spec extends TurboModule {
  light: (viewTag: CodegenTypes.Double) => void
}
export default TurboModuleRegistry.get<Spec>('TSHaptics')
