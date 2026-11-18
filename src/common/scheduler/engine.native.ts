import NativeScheduler from '../../app/scheduling/NativeScheduler'
import { nativeEngine } from './nativeEngine'
import type { EngineBuild, EngineRequest, EngineSession } from './wire'

export * from './wire'

/**
 * The Auto-Scheduler's C++ engine on iOS and Android: the `NativeScheduler`
 * TurboModule, compiled into the app. An app built without the module is
 * the `noSolver` failure.
 */
const native = nativeEngine(NativeScheduler ?? null)

export async function buildSchedule(
  request: EngineRequest,
  session?: EngineSession
): Promise<EngineBuild> {
  return await native.build(request, session)
}
