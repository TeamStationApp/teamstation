import type { TurboModule } from 'react-native'
import { TurboModuleRegistry } from 'react-native'

export interface Spec extends TurboModule {
  open: (url: string) => Promise<void>
}

export default TurboModuleRegistry.get<Spec>('TSChatBrowser')
