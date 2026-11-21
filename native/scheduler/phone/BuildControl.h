// What JavaScript and a build's thread share, on the phones
// (phone/NativeScheduler.cpp) and in the Node addon (node/SchedulerAddon.cpp):
// the cancel flag, and the answer to a pause at the time limit, which the
// build waits for on a condition variable. And the builds a module or an
// addon's environment has started, so that when it goes (a JavaScript
// reload, an environment torn down) each one still running is stopped: a
// build paused at its time limit would otherwise wait forever for an answer
// that cannot come, holding the one-build lock. Free of JSI and Node-API, so
// the engine's tests run it.
#pragma once

#include <atomic>
#include <condition_variable>
#include <memory>
#include <mutex>
#include <optional>
#include <vector>

#include "Engine.h"

namespace teamstation::scheduler {

struct Control {
  std::atomic<bool> cancel{false};
  std::mutex mutex;
  std::condition_variable changed;
  std::optional<Decision> answer;

  void stop() {
    {
      const std::lock_guard<std::mutex> lock(mutex);
      cancel.store(true);
    }
    changed.notify_all();
  }

  // An answer given early answers the next pause.
  void decide(Decision decision) {
    {
      const std::lock_guard<std::mutex> lock(mutex);
      if (!answer) answer = decision;
    }
    changed.notify_all();
  }

  // On the build thread: waits for the answer, or for cancel.
  Decision wait() {
    std::unique_lock<std::mutex> lock(mutex);
    changed.wait(lock, [this] { return answer.has_value() || cancel.load(); });
    if (cancel.load()) return Decision::Cancel;
    const Decision decision = *answer;
    answer.reset();
    return decision;
  }
};

// The builds started and not yet gone; a build is held only weakly, so one
// that has finished is simply passed over.
class LiveBuilds {
 public:
  // A build started after `stopAll` is stopped at once.
  void add(const std::shared_ptr<Control>& control) {
    const std::lock_guard<std::mutex> lock(mutex_);
    if (stopped_) {
      control->stop();
      return;
    }
    std::vector<std::weak_ptr<Control>> kept;
    for (const std::weak_ptr<Control>& each : builds_)
      if (!each.expired()) kept.push_back(each);
    kept.push_back(control);
    builds_.swap(kept);
  }

  // Stops every build still running, as its owner goes.
  void stopAll() {
    std::vector<std::weak_ptr<Control>> builds;
    {
      const std::lock_guard<std::mutex> lock(mutex_);
      stopped_ = true;
      builds.swap(builds_);
    }
    for (const std::weak_ptr<Control>& each : builds)
      if (const std::shared_ptr<Control> control = each.lock()) control->stop();
  }

  size_t size() const {
    const std::lock_guard<std::mutex> lock(mutex_);
    return builds_.size();
  }

 private:
  mutable std::mutex mutex_;
  std::vector<std::weak_ptr<Control>> builds_;
  bool stopped_ = false;
};

}  // namespace teamstation::scheduler
