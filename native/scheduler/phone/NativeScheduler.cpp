#include "NativeScheduler.h"

#include <pthread.h>

#include <functional>
#include <mutex>
#include <optional>
#include <string>
#include <utility>

#if defined(__APPLE__)
#include <pthread/qos.h>
#elif defined(__ANDROID__)
#include <sys/resource.h>
#include <unistd.h>
#endif

#include "BuildControl.h"
#include "Engine.h"
#include "Outbox.h"

namespace facebook::react {

namespace {

// The build's stack: HiGHS's branch and bound goes deeper than a
// secondary thread's default 512 KB on iOS.
constexpr size_t kStackBytes = 8 * 1024 * 1024;

// One build at a time, as in the Node addon: HiGHS and the engine are
// single-threaded, and a second build waits for the first rather than
// sharing a core with it.
std::mutex building;

// What a build holds of JavaScript. Made, read and deleted on the JS thread
// only, and only while the runtime that made it lives: a build that outlives
// its runtime leaks this rather than freeing it on another thread or
// against another runtime.
struct JsSide {
  jsi::Value resolve;
  jsi::Function onProgress;
};

using teamstation::scheduler::Control;
using teamstation::scheduler::Decision;

std::optional<Decision> decisionOf(const std::string &choice) {
  if (choice == "continue") return Decision::Continue;
  if (choice == "use") return Decision::Use;
  if (choice == "cancel") return Decision::Cancel;
  return std::nullopt;
}

// The thread's body, handed over through pthread_create.
void *runJob(void *argument) {
  std::unique_ptr<std::function<void()>> job(
      static_cast<std::function<void()> *>(argument));
#if defined(__ANDROID__)
  // Android's "urgent display" priority, which an app may give its threads.
  setpriority(PRIO_PROCESS, static_cast<id_t>(gettid()), -8);
#endif
  (*job)();
  return nullptr;
}

// Starts `job` on a detached thread with an 8 MB stack and a high priority;
// false when the thread could not be made.
bool startThread(std::function<void()> job) {
  pthread_attr_t attributes;
  if (pthread_attr_init(&attributes) != 0) return false;
  pthread_attr_setstacksize(&attributes, kStackBytes);
  pthread_attr_setdetachstate(&attributes, PTHREAD_CREATE_DETACHED);
#if defined(__APPLE__)
  pthread_attr_set_qos_class_np(&attributes, QOS_CLASS_USER_INITIATED, 0);
#endif
  auto *owned = new std::function<void()>(std::move(job));
  pthread_t thread;
  const int made = pthread_create(&thread, &attributes, runJob, owned);
  pthread_attr_destroy(&attributes);
  if (made != 0) {
    delete owned;
    return false;
  }
  return true;
}

// The engine's answer, whatever happens: nothing escapes the build thread.
std::string answer(
    const std::string &request,
    Control &control,
    const std::function<void(std::string)> &emit) {
  try {
    const std::lock_guard<std::mutex> lock(building);
    teamstation::scheduler::Reporter reporter;
    reporter.emit = [&emit](const std::string &event) { emit(event); };
    reporter.decide = [&control] { return control.wait(); };
    return teamstation::scheduler::buildSchedule(request, control.cancel, reporter);
  } catch (...) {
    return R"({"kind":"failure","failure":"broken","message":"The scheduler failed"})";
  }
}

} // namespace

NativeScheduler::NativeScheduler(std::shared_ptr<CallInvoker> jsInvoker)
    : NativeSchedulerCxxSpec(std::move(jsInvoker)),
      live_(std::make_shared<teamstation::scheduler::LiveBuilds>()) {}

// The module goes with its runtime (a reload): nothing is delivered to that
// runtime again, and every build still running is stopped, a paused one
// included, so that it frees the one-build lock for the next runtime's.
NativeScheduler::~NativeScheduler() {
  alive_->store(false);
  live_->stopAll();
}

jsi::Object NativeScheduler::build(
    jsi::Runtime &rt,
    jsi::String request,
    jsi::Function onProgress) {
  auto text = std::make_shared<std::string>(request.utf8(rt));
  auto control = std::make_shared<Control>();
  live_->add(control);
  JsSide *js = nullptr;
  auto executor = jsi::Function::createFromHostFunction(
      rt,
      jsi::PropNameID::forAscii(rt, "buildSchedule"),
      2,
      [&js, &onProgress](
          jsi::Runtime &rt,
          const jsi::Value &,
          const jsi::Value *args,
          size_t count) -> jsi::Value {
        // Run at once, inside the Promise constructor below.
        if (count >= 1)
          js = new JsSide{jsi::Value(rt, args[0]), std::move(onProgress)};
        return jsi::Value::undefined();
      });
  jsi::Value promise = rt.global()
                           .getPropertyAsFunction(rt, "Promise")
                           .callAsConstructor(rt, std::move(executor));

  auto invoker = jsInvoker_;
  auto alive = alive_;
  // Every event and then the answer go through one outbox, and each
  // delivery on the JS thread hands over all that is waiting, in order: the
  // JS thread's scheduler does not promise to run two tasks posted at the
  // same instant in the order they were posted, so a task per message could
  // let the answer overtake the last events.
  auto outbox = std::make_shared<teamstation::scheduler::Outbox>();
  auto deliver = [alive, js, outbox](jsi::Runtime &rt) {
    if (!alive->load()) return;
    outbox->deliver(
        [&rt, js](const std::string &event) {
          try {
            js->onProgress.call(rt, jsi::String::createFromUtf8(rt, event));
          } catch (const std::exception &) {
            // A callback that throws loses its event, not the build.
          }
        },
        // The answer, to the promise, which frees what the build held of
        // JavaScript; nothing is delivered after it.
        [&rt, js](const std::string &result) {
          std::unique_ptr<JsSide> owned(js);
          owned->resolve.asObject(rt).asFunction(rt).call(
              rt, jsi::String::createFromUtf8(rt, result));
        });
  };
  auto post = [invoker, alive, outbox, deliver](bool result, std::string text) {
    if (!alive->load()) return;
    if (outbox->send(result, std::move(text)))
      invoker->invokeAsync([deliver](jsi::Runtime &rt) { deliver(rt); });
  };
  auto settle = [post](std::string result) { post(true, std::move(result)); };
  auto emit = [post](std::string event) { post(false, std::move(event)); };
  if (js != nullptr &&
      !startThread([text, control, settle, emit]() {
        settle(answer(*text, *control, emit));
      })) {
    settle(R"({"kind":"failure","failure":"broken","message":"The scheduler could not start its thread"})");
  }

  jsi::Object handle(rt);
  handle.setProperty(rt, "promise", std::move(promise));
  handle.setProperty(
      rt,
      "cancel",
      jsi::Function::createFromHostFunction(
          rt,
          jsi::PropNameID::forAscii(rt, "cancel"),
          0,
          [control](jsi::Runtime &, const jsi::Value &, const jsi::Value *, size_t) {
            control->stop();
            return jsi::Value::undefined();
          }));
  // The answer to a pause at the time limit: 'continue', 'use' or 'cancel'.
  handle.setProperty(
      rt,
      "decide",
      jsi::Function::createFromHostFunction(
          rt,
          jsi::PropNameID::forAscii(rt, "decide"),
          1,
          [control](
              jsi::Runtime &rt,
              const jsi::Value &,
              const jsi::Value *args,
              size_t count) {
            if (count >= 1 && args[0].isString())
              if (const auto decision = decisionOf(args[0].asString(rt).utf8(rt)))
                control->decide(*decision);
            return jsi::Value::undefined();
          }));
  return handle;
}

} // namespace facebook::react
