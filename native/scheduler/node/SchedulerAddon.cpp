// The engine as a Node-API addon (src/common/scheduler/node/scheduler.node,
// built by scripts/schedulerBuild.mjs node), with the shape the phones'
// NativeScheduler has: `build(request, onProgress)` starts one build on a
// thread of its own, so the caller's event loop stays free, and answers
// `{ promise, cancel, decide }`.
//
// - Each event the engine reports (a phase starting or ending, the solver's progress, the time
//   limit) reaches `onProgress` as its JSON, on the JS thread, in order; the
//   promise then resolves with the result JSON, after the last event.
// - At the time limit the build waits on a condition variable for
//   `decide('continue' | 'use' | 'cancel')`, which answers the pause it is
//   in (or, said early, the next one).
// - `cancel()` sets the build's flag, which HiGHS's interrupt callbacks and
//   the engine's own steps read, and wakes a paused build; the build answers
//   `canceled`. The environment's teardown does the same for every build
//   still running.
//
// The engine itself never throws; anything else that escapes the worker
// rejects the promise.
#include <pthread.h>

#include <atomic>
#include <memory>
#include <mutex>
#include <optional>
#include <string>

#include "../Engine.h"
#include "../phone/BuildControl.h"
#include "napi.h"

namespace {

using teamstation::scheduler::Control;
using teamstation::scheduler::Decision;
using teamstation::scheduler::LiveBuilds;

// One build at a time: HiGHS and the engine are single-threaded, and a
// second build waits for the first rather than sharing a core with it. A
// build canceled while it waits answers as soon as it gets its turn.
std::mutex building;

// One message from the build thread to JavaScript: an event, the result,
// or what escaped the engine.
struct Message {
  enum class Kind { Event, Result, Error } kind = Kind::Event;
  std::string text;
};

// What only the JS thread touches: the promise and the progress callback.
// Freed on the JS thread, by the message queue's finalizer.
struct JsSide {
  explicit JsSide(Napi::Env env) : deferred(env) {}
  Napi::Promise::Deferred deferred;
  Napi::FunctionReference onProgress;
};

// A build on its own thread. Not libuv's pool: an environment being torn
// down waits for the pool's work before it runs its cleanup hooks, so a
// build paused there would hold the teardown, and never hear the hook that
// stops it.
// Whether the message queue is gone: an environment torn down finalizes it
// though the build still holds it, and nothing may touch it after that.
struct Queue {
  std::mutex mutex;
  bool gone = false;
};

struct Job {
  std::string request;
  std::shared_ptr<Control> control;
  // Every message goes through one queue, so the result comes after the
  // last event.
  Napi::ThreadSafeFunction messages;
  JsSide* js = nullptr;
  std::shared_ptr<Queue> queue = std::make_shared<Queue>();

  void send(Message::Kind kind, const std::string& text) {
    const std::lock_guard<std::mutex> lock(queue->mutex);
    if (queue->gone) return;
    auto* message = new Message{kind, text};
    JsSide* side = js;
    const napi_status sent = messages.NonBlockingCall(
        message, [side](Napi::Env env, Napi::Function, Message* data) {
          const std::unique_ptr<Message> owned(data);
          if (env == nullptr) return;
          const Napi::String text = Napi::String::New(env, owned->text);
          if (owned->kind == Message::Kind::Result) {
            side->deferred.Resolve(text);
          } else if (owned->kind == Message::Kind::Error) {
            side->deferred.Reject(Napi::Error::New(env, owned->text).Value());
          } else if (!side->onProgress.IsEmpty()) {
            // A callback that throws loses its event, not the build.
            try {
              side->onProgress.Call({text});
            } catch (const Napi::Error&) {
            }
          }
        });
    // The environment is going: nothing more reaches it.
    if (sent != napi_ok) delete message;
  }

  void run() {
    Message::Kind kind = Message::Kind::Result;
    std::string text;
    {
      const std::lock_guard<std::mutex> lock(building);
      try {
        teamstation::scheduler::Reporter reporter;
        reporter.emit = [this](const std::string& event) { send(Message::Kind::Event, event); };
        reporter.decide = [this] { return control->wait(); };
        text = teamstation::scheduler::buildSchedule(request, control->cancel, reporter);
      } catch (const std::exception& error) {
        kind = Message::Kind::Error;
        text = error.what();
      } catch (...) {
        kind = Message::Kind::Error;
        text = "The scheduler failed";
      }
    }
    send(kind, text);
    const std::lock_guard<std::mutex> lock(queue->mutex);
    if (!queue->gone) messages.Release();
  }
};

// The build's stack: HiGHS's branch and bound goes deeper than a secondary
// thread's default 512 KB on macOS.
constexpr size_t kStackBytes = 8 * 1024 * 1024;

void* runJob(void* argument) {
  std::unique_ptr<Job> job(static_cast<Job*>(argument));
  job->run();
  return nullptr;
}

// Starts the job on a detached thread; false when none could be made.
bool startThread(Job* job) {
  pthread_attr_t attributes;
  if (pthread_attr_init(&attributes) != 0) return false;
  pthread_attr_setstacksize(&attributes, kStackBytes);
  pthread_attr_setdetachstate(&attributes, PTHREAD_CREATE_DETACHED);
  pthread_t thread;
  const int made = pthread_create(&thread, &attributes, runJob, job);
  pthread_attr_destroy(&attributes);
  return made == 0;
}

std::optional<Decision> decisionOf(const std::string& choice) {
  if (choice == "continue") return Decision::Continue;
  if (choice == "use") return Decision::Use;
  if (choice == "cancel") return Decision::Cancel;
  return std::nullopt;
}

Napi::Value Build(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "build(request) takes the request as JSON text")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  auto control = std::make_shared<Control>();
  static_cast<LiveBuilds*>(info.Data())->add(control);
  auto* js = new JsSide(env);
  if (info.Length() >= 2 && info[1].IsFunction())
    js->onProgress = Napi::Persistent(info[1].As<Napi::Function>());
  Napi::Object handle = Napi::Object::New(env);
  handle.Set("promise", js->deferred.Promise());
  auto* job = new Job{info[0].As<Napi::String>().Utf8Value(), control, {}, js};
  job->messages = Napi::ThreadSafeFunction::New(
      env, Napi::Function::New(env, [](const Napi::CallbackInfo&) {}), "scheduler", 0, 1, js,
      [](Napi::Env, std::shared_ptr<Queue>* queue, JsSide* side) {
        {
          const std::lock_guard<std::mutex> lock((*queue)->mutex);
          (*queue)->gone = true;
        }
        delete queue;
        delete side;
      },
      new std::shared_ptr<Queue>(job->queue));
  if (!startThread(job)) {
    js->deferred.Reject(
        Napi::Error::New(env, "The scheduler could not start its thread").Value());
    job->messages.Release();
    delete job;
  }
  handle.Set("cancel", Napi::Function::New(
                           env,
                           [control](const Napi::CallbackInfo& call) {
                             control->stop();
                             return call.Env().Undefined();
                           },
                           "cancel"));
  handle.Set("decide", Napi::Function::New(
                           env,
                           [control](const Napi::CallbackInfo& call) {
                             if (call.Length() >= 1 && call[0].IsString())
                               if (const auto decision =
                                       decisionOf(call[0].As<Napi::String>().Utf8Value()))
                                 control->decide(*decision);
                             return call.Env().Undefined();
                           },
                           "decide"));
  return handle;
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  // This environment's builds. When it is torn down (a worker thread ends,
  // the process exits) each one still running is stopped, a paused one
  // included, so it frees the one-build lock that every environment's
  // builds share.
  auto* live = new LiveBuilds();
  napi_add_env_cleanup_hook(
      env,
      [](void* data) {
        auto* builds = static_cast<LiveBuilds*>(data);
        builds->stopAll();
        delete builds;
      },
      live);
  exports.Set("build", Napi::Function::New(env, Build, "build", live));
  return exports;
}

}  // namespace

NODE_API_MODULE(scheduler, Init)
