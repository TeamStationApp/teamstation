// A real Hermes runtime and JS queue for the two native registration tests.
#pragma once
#include <ReactCommon/CallInvoker.h>
#include <ReactCommon/TurboModule.h>
#include <hermes/hermes.h>
#include <react/bridging/LongLivedObject.h>
#include <chrono>
#include <condition_variable>
#include <deque>
#include <mutex>

namespace preview_test {
namespace react = facebook::react;
namespace jsi = facebook::jsi;

class Queue final : public react::CallInvoker {
 public:
  explicit Queue(jsi::Runtime &runtime) : runtime_(runtime) {}

  void invokeAsync(react::CallFunc &&call) noexcept override {
    {
      std::lock_guard guard(mutex_);
      pending_.push_back(std::move(call));
    }
    ready_.notify_one();
  }
  void invokeSync(react::CallFunc &&call) override { call(runtime_); }

  bool next(std::chrono::steady_clock::time_point deadline) {
    std::unique_lock lock(mutex_);
    if (!ready_.wait_until(lock, deadline, [&] { return !pending_.empty(); }))
      return false;
    auto call = std::move(pending_.front());
    pending_.pop_front();
    lock.unlock();
    call(runtime_);
    runtime_.drainMicrotasks();
    return true;
  }

 private:
  jsi::Runtime &runtime_;
  std::mutex mutex_;
  std::condition_variable ready_;
  std::deque<react::CallFunc> pending_;
};

template<class Provider>
bool exercisesPreview(Provider provider) {
  auto runtime = facebook::hermes::makeHermesRuntime(
      ::hermes::vm::RuntimeConfig::Builder().withMicrotaskQueue(true).build());
  auto &rt = *runtime;
  auto queue = std::make_shared<Queue>(rt);
  auto module = provider(queue);
  if (!module) return false;
  auto object = jsi::Object::createFromHostObject(rt, module);
  rt.global().setProperty(rt, "preview", std::move(object));
  auto script = std::make_shared<jsi::StringBuffer>(
      "globalThis.completed = 0;"
      "const finished = value => { if (value === '') completed++; };"
      "preview.read(1, 'https://page.example.test/', 0, 100).then(finished);"
      "preview.cancel(1);"
      "preview.read(2, 'https://page.example.test/', 1, 100).then(finished);"
      "preview.read(3, 'https://page.example.test/', 2, 1).then(finished);"
      "preview.cancel(999);"
      "globalThis.preview = undefined;");
  rt.evaluateJavaScript(script, "preview-test.js");
  module.reset();
  runtime->drainMicrotasks();
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(8);
  while (rt.global().getProperty(rt, "completed").getNumber() != 3) {
    if (!queue->next(deadline)) return false;
  }
  react::LongLivedObjectCollection::get(rt).clear();
  return true;
}
} // namespace preview_test
