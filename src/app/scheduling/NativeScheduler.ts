import type { CodegenTypes, TurboModule } from 'react-native'
import { TurboModuleRegistry } from 'react-native'

// The Auto-Scheduler's engine on iOS and Android: a pure C++ module
// (native/scheduler/phone/NativeScheduler.cpp) over native/scheduler and
// HiGHS, compiled into the app. `build` takes the engine's request as JSON
// and starts one build on a thread of its own (8 MB stack, high priority),
// answering at once with `{ promise, cancel, decide }`: the promise of the
// result's JSON, a way to stop the build, and the answer to a pause.
// `onProgress` hears each event the engine reports. `engine.native.ts` is
// its only user.
export interface Spec extends TurboModule {
  build: (
    request: string,
    onProgress: (event: string) => void
  ) => CodegenTypes.UnsafeObject
}

export default TurboModuleRegistry.get<Spec>('NativeScheduler')
