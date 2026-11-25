import type { TurboModule } from 'react-native'
import { TurboModuleRegistry } from 'react-native'

export interface Spec extends TurboModule {
  /** Settles when Safari leaves the screen, or rejects if presentation fails. */
  open: (url: string) => Promise<void>
}

export default TurboModuleRegistry.get<Spec>('TSChatBrowser')
