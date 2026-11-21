// The Auto-Scheduler's engine on iOS and Android: a pure C++ TurboModule over
// native/scheduler and HiGHS, compiled into the app (scripts/highsNative.sh,
// android/app/src/main/jni/CMakeLists.txt). Its spec is
// src/app/scheduling/NativeScheduler.ts: `build(request, onProgress)` starts
// one build on a thread of its own and answers `{ promise, cancel, decide }`.
// Each event reaches `onProgress` on the JS thread; at the time limit the
// build waits on a condition variable for `decide`, which `cancel` also wakes,
// as does the module's going with its runtime.
#pragma once

#if __has_include(<TeamStationWalkUpMusicSpecJSI.h>)
#include <TeamStationWalkUpMusicSpecJSI.h>
#else
#include <ReactCodegen/TeamStationWalkUpMusicSpecJSI.h>
#endif

#include <atomic>
#include <memory>

namespace teamstation::scheduler {
class LiveBuilds;
}

namespace facebook::react {

class NativeScheduler : public NativeSchedulerCxxSpec<NativeScheduler> {
 public:
  explicit NativeScheduler(std::shared_ptr<CallInvoker> jsInvoker);
  ~NativeScheduler() override;

  jsi::Object build(jsi::Runtime &rt, jsi::String request, jsi::Function onProgress);

 private:
  // Cleared when the module goes with its runtime (a reload): a build that
  // finishes later must not touch that runtime's values.
  std::shared_ptr<std::atomic<bool>> alive_ =
      std::make_shared<std::atomic<bool>>(true);
  // Its builds, stopped when it goes.
  std::shared_ptr<teamstation::scheduler::LiveBuilds> live_;
};

} // namespace facebook::react
