import {
  type EngineBuild,
  type EngineHandle,
  type EngineRequest,
  type EngineSession,
  failure,
  runBuild
} from './wire'

/** The `NativeScheduler` TurboModule's shape, as `engine.native.ts` hands it over. */
export interface NativeSchedulerModule {
  build: (request: string, onProgress: (event: string) => void) => object
}

/** What a build answers on a phone whose app has no engine. */
export const NO_NATIVE_SCHEDULER = failure(
  'noSolver',
  'This app was built without the scheduler'
)

/** A handle as the module answers it, or nothing when it is not one. */
function handleOf(value: object): EngineHandle | null {
  const handle = value as Partial<EngineHandle>
  return handle.promise instanceof Promise &&
    typeof handle.cancel === 'function' &&
    typeof handle.decide === 'function'
    ? (handle as EngineHandle)
    : null
}

/**
 * The engine through the phones' native module: present or not when the app
 * starts. A missing module is the `noSolver` failure; a module that throws
 * or answers something else is `broken`.
 */
export function nativeEngine(module: NativeSchedulerModule | null): {
  build: (
    request: EngineRequest,
    session?: EngineSession
  ) => Promise<EngineBuild>
  available: () => boolean
} {
  return {
    available: () => module != null,
    build: async (request, session) => {
      if (module == null) return NO_NATIVE_SCHEDULER
      try {
        return await runBuild(
          (text, onProgress) => {
            const handle = handleOf(module.build(text, onProgress))
            if (handle == null)
              throw new Error('NativeScheduler answered no build')
            return handle
          },
          request,
          session
        )
      } catch (error) {
        return failure(
          'broken',
          error instanceof Error ? error.message : String(error)
        )
      }
    }
  }
}
