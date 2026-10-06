// The chat crypto core's TurboModule on iOS and Android: a pure C++ module
// over the Rust static library built from crates/chat-crypto
// (scripts/chatCryptoNative.sh). Its spec is src/app/chat/NativeChatCrypto.ts:
// one synchronous call, an op from src/common/chatCrypto/ops.json and its
// encoded arguments in an ArrayBuffer, the encoded answer back in another.
#pragma once

#if __has_include(<TeamStationWalkUpMusicSpecJSI.h>)
#include <TeamStationWalkUpMusicSpecJSI.h>
#else
#include <ReactCodegen/TeamStationWalkUpMusicSpecJSI.h>
#endif

#include <memory>

namespace facebook::react {

class NativeChatCrypto : public NativeChatCryptoCxxSpec<NativeChatCrypto> {
 public:
  explicit NativeChatCrypto(std::shared_ptr<CallInvoker> jsInvoker);

  jsi::Object call(jsi::Runtime &rt, int op, jsi::Object input);
};

} // namespace facebook::react
