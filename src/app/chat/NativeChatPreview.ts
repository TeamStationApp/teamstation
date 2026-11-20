import type { CodegenTypes, TurboModule } from 'react-native'
import { TurboModuleRegistry } from 'react-native'

export interface Spec extends TurboModule {
  read: (
    id: CodegenTypes.Int32,
    url: string,
    kind: CodegenTypes.Int32,
    size: CodegenTypes.Int32
  ) => Promise<string>
  cancel: (id: CodegenTypes.Int32) => void
}
export default TurboModuleRegistry.get<Spec>('NativeChatPreview')
