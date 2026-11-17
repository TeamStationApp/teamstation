import type { CodegenTypes, TurboModule } from 'react-native'
import { TurboModuleRegistry } from 'react-native'

/**
 * Codegen contract for handing a game plan PDF in the cache to the system:
 * its share sheet and its print dialog, each pointing at the given window
 * rectangle on an iPad.
 */
export interface Spec extends TurboModule {
  share: (
    path: string,
    x: CodegenTypes.Double,
    y: CodegenTypes.Double,
    width: CodegenTypes.Double,
    height: CodegenTypes.Double
  ) => Promise<void>
  print: (
    path: string,
    jobName: string,
    x: CodegenTypes.Double,
    y: CodegenTypes.Double,
    width: CodegenTypes.Double,
    height: CodegenTypes.Double
  ) => Promise<void>
}
export default TurboModuleRegistry.get<Spec>('TSPlanDocument')
