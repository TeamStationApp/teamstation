#include "NativeChatPreview.h"
#include <react/bridging/Promise.h>
#include <thread>

extern "C" {
void *chat_preview_job();
void chat_preview_cancel(const void *);
void chat_preview_release(void *);
char *chat_preview_read(const void *, const uint8_t *, size_t, int32_t, int32_t);
void chat_preview_free(char *);
}

namespace facebook::react {
NativeChatPreview::NativeChatPreview(std::shared_ptr<CallInvoker> invoker, Launch launch)
    : NativeChatPreviewCxxSpec(invoker), state_(std::make_shared<State>()),
      invoker_(std::move(invoker)), launch_(std::move(launch)) {}

void NativeChatPreview::startWorker(std::function<void()> work) {
  std::thread(std::move(work)).detach();
}

NativeChatPreview::~NativeChatPreview() {
  std::lock_guard guard(state_->mutex);
  for (const auto &entry : state_->jobs) chat_preview_cancel(entry.second.get());
}

void NativeChatPreview::cancel(jsi::Runtime &, int id) {
  std::lock_guard guard(state_->mutex);
  auto it = state_->jobs.find(id);
  if (it != state_->jobs.end()) chat_preview_cancel(it->second.get());
}

jsi::Object NativeChatPreview::read(jsi::Runtime &rt, int id, std::string url,
                                   int kind, int size) {
  AsyncPromise<std::string> promise(rt, invoker_);
  auto result = promise.get(rt);
  std::shared_ptr<void> job(chat_preview_job(), chat_preview_release);
  {
    std::lock_guard guard(state_->mutex);
    if (state_->jobs.size() >= 2 || !state_->jobs.emplace(id, job).second) {
      promise.resolve("");
      return result;
    }
  }
  auto state = state_;
  try {
    launch_([state, job, id, kind, size, url = std::move(url), promise, invoker = invoker_]() mutable {
      std::unique_ptr<char, decltype(&chat_preview_free)> data(
          chat_preview_read(job.get(), reinterpret_cast<const uint8_t *>(url.data()),
                            url.size(), kind, size), chat_preview_free);
      {
        std::lock_guard guard(state->mutex);
        state->jobs.erase(id);
      }
      // Settle and release the Hermes callback handles on their owning JS thread.
      std::string value = data ? data.get() : "";
      invoker->invokeAsync(
          [promise = std::move(promise), value = std::move(value)](jsi::Runtime &) mutable {
            promise.resolve(std::move(value));
          });
    });
  } catch (const std::system_error &) {
    std::lock_guard guard(state->mutex);
    state->jobs.erase(id);
    promise.resolve("");
  }
  return result;
}
}
