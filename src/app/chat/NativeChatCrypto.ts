import type { CodegenTypes, TurboModule } from 'react-native'
import { TurboModuleRegistry } from 'react-native'

// The chat crypto core's TurboModule on iOS and Android: a pure C++ module
// (native/chatCrypto/NativeChatCrypto.cpp) over the Rust static library
// built from crates/chat-crypto. One synchronous method: an op from
// src/common/chatCrypto/ops.json and its encoded arguments in an
// ArrayBuffer, the encoded answer back in another. `core.native.ts` is its
// only user.
export interface Spec extends TurboModule {
  call: (
    op: CodegenTypes.Int32,
    input: CodegenTypes.UnsafeObject
  ) => CodegenTypes.UnsafeObject
}

export default TurboModuleRegistry.get<Spec>('NativeChatCrypto')
