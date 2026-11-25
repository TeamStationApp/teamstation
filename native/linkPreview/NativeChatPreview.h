#pragma once
#if __has_include(<TeamStationWalkUpMusicSpecJSI.h>)
#include <TeamStationWalkUpMusicSpecJSI.h>
#else
#include <ReactCodegen/TeamStationWalkUpMusicSpecJSI.h>
#endif

#include <functional>
#include <memory>
#include <mutex>
#include <unordered_map>

namespace facebook::react {
class NativeChatPreview : public NativeChatPreviewCxxSpec<NativeChatPreview> {
 public:
  using Launch = std::function<void(std::function<void()>)>;
  explicit NativeChatPreview(std::shared_ptr<CallInvoker> invoker, Launch launch = startWorker);
  ~NativeChatPreview() override;
  jsi::Object read(jsi::Runtime &rt, int id, std::string url, int kind, int size);
  void cancel(jsi::Runtime &rt, int id);

 private:
  static void startWorker(std::function<void()> work);
  struct State {
    std::mutex mutex;
    std::unordered_map<int, std::shared_ptr<void>> jobs;
  };
  std::shared_ptr<State> state_;
  std::shared_ptr<CallInvoker> invoker_;
  Launch launch_;
};
}
