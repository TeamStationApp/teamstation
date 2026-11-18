// What a phone's build sends JavaScript, in the order the build sends it:
// each event, then the result. native/scheduler/phone/NativeScheduler.cpp
// posts one delivery to the JS thread for each message it sends, and each
// delivery hands over everything sent so far, in order. So whichever
// delivery runs first, and in whatever order the JS thread runs them (React
// Native's scheduler orders its tasks by deadline alone, so two posted at the
// same instant may run either way round), every event the build sent before
// its result reaches JavaScript before the result does, and nothing is sent
// after the result. Free of JSI, so the engine's tests run it.
#pragma once

#include <deque>
#include <functional>
#include <mutex>
#include <string>
#include <utility>

namespace teamstation::scheduler {

class Outbox {
 public:
  // Queues an event, or the result. False when nothing needs delivering: the
  // result has already been sent, and nothing may follow it.
  bool send(bool result, std::string text) {
    const std::lock_guard<std::mutex> lock(mutex_);
    if (closed_) return false;
    queue_.push_back(Message{result, std::move(text)});
    if (result) closed_ = true;
    return true;
  }

  // Hands over what is waiting, in order: each event to `onEvent`, and the
  // result, which is always last, to `onResult`. A delivery that finds
  // nothing waiting (an earlier one took it) does nothing.
  void deliver(const std::function<void(const std::string &)> &onEvent,
               const std::function<void(const std::string &)> &onResult) {
    std::deque<Message> waiting;
    {
      const std::lock_guard<std::mutex> lock(mutex_);
      waiting.swap(queue_);
    }
    for (const Message &message : waiting) {
      if (message.result) {
        onResult(message.text);
        return;
      }
      onEvent(message.text);
    }
  }

 private:
  struct Message {
    bool result;
    std::string text;
  };
  std::mutex mutex_;
  std::deque<Message> queue_;
  bool closed_ = false;
};

}  // namespace teamstation::scheduler
