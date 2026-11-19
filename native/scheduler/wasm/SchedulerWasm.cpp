// The engine as WebAssembly for the web's worker (src/app/platform/
// schedulerWorker.ts), built by scripts/schedulerBuild.mjs wasm with the
// pinned Emscripten: `scheduler_build` takes the request as UTF-8 JSON and
// answers the result as UTF-8 JSON in memory the caller frees with
// `scheduler_free`. The engine never throws, so neither does this; a
// worker that cannot allocate the answer traps, and the page hears the
// worker fail.
//
// Each event the engine reports goes to the worker's
// `Module.onSchedulerEvent(json)` as it happens. At the time limit the
// build waits for `Module.schedulerDecide()`, a promise of 0 (continue),
// 1 (use) or 2 (cancel), through Emscripten's Asyncify: `scheduler_decide`
// is the one import that may suspend, and only the call chain from the
// export down to it is instrumented (native/scheduler/CMakeLists.txt). The
// worker therefore calls `scheduler_build` through `ccall` with
// `{ async: true }`, and runs one build at a time. Built without Asyncify
// (SCHEDULER_ASYNCIFY off, only to measure what it costs), a build at its
// limit takes its best schedule.
#include <cstdlib>
#include <cstring>
#include <string>

#include <emscripten/emscripten.h>

#include "../Engine.h"

using teamstation::scheduler::Decision;

EM_JS(void, scheduler_event, (const char* event), {
  if (typeof Module.onSchedulerEvent === 'function')
    Module.onSchedulerEvent(UTF8ToString(event));
});

#if SCHEDULER_ASYNCIFY
EM_ASYNC_JS(int, scheduler_decide, (), {
  return typeof Module.schedulerDecide === 'function' ? await Module.schedulerDecide() : 1;
});
#else
EM_JS(int, scheduler_decide, (), { return 1; });
#endif

extern "C" {

EMSCRIPTEN_KEEPALIVE char* scheduler_build(const char* request) {
  const std::atomic<bool> never{false};
  teamstation::scheduler::Reporter reporter;
  reporter.emit = [](const std::string& event) { scheduler_event(event.c_str()); };
  reporter.decide = [] {
    const int answer = scheduler_decide();
    return answer == 0 ? Decision::Continue : answer == 2 ? Decision::Cancel : Decision::Use;
  };
  const std::string answer = teamstation::scheduler::buildSchedule(
      request == nullptr ? "" : request, never, reporter);
  char* out = static_cast<char*>(std::malloc(answer.size() + 1));
  if (out == nullptr) return nullptr;
  std::memcpy(out, answer.c_str(), answer.size() + 1);
  return out;
}

EMSCRIPTEN_KEEPALIVE void scheduler_free(char* answer) { std::free(answer); }

}  // extern "C"
