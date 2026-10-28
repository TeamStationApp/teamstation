#include "NativeChatCrypto.h"

#include "chat_crypto.h"

namespace facebook::react {

namespace {

// The core's answer, handed to JavaScript without a copy and given back to
// Rust (which zeroes it) when the ArrayBuffer is collected.
class CoreAnswer : public jsi::MutableBuffer {
 public:
  CoreAnswer(uint8_t *data, size_t size) : data_(data), size_(size) {}
  ~CoreAnswer() override {
    chat_crypto_free(data_, size_);
  }
  size_t size() const override {
    return size_;
  }
  uint8_t *data() override {
    return data_;
  }

 private:
  uint8_t *data_;
  size_t size_;
};

} // namespace

NativeChatCrypto::NativeChatCrypto(std::shared_ptr<CallInvoker> jsInvoker)
    : NativeChatCryptoCxxSpec(std::move(jsInvoker)) {}

jsi::Object NativeChatCrypto::call(jsi::Runtime &rt, int op, jsi::Object input) {
  if (op < 0 || !input.isArrayBuffer(rt)) {
    throw jsi::JSError(rt, "NativeChatCrypto.call takes an op and an ArrayBuffer");
  }
  jsi::ArrayBuffer buffer = input.getArrayBuffer(rt);
  uint8_t *out = nullptr;
  size_t outLength = 0;
  chat_crypto_call(
      static_cast<uint32_t>(op), buffer.data(rt), buffer.size(rt), &out, &outLength);
  return jsi::ArrayBuffer(rt, std::make_shared<CoreAnswer>(out, outLength));
}

} // namespace facebook::react
