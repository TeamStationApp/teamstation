import NativeChatCrypto from '../../app/chat/NativeChatCrypto'
import {
  type ChatCoreStatus,
  ChatCryptoUnavailable,
  type CoreCall
} from './coreCall'
import { coreOf } from './nativeCore'

/**
 * The chat crypto core on iOS and Android: the `NativeChatCrypto`
 * TurboModule, C++ over the Rust static library built from
 * `crates/chat-crypto`. It is there or not when the app starts, so the status
 * is settled at once: `noNativeModule` for a build without it, and
 * `selfTestFailed` if it gives other bytes than the frozen ones.
 */

const core = coreOf(NativeChatCrypto)

export const call: CoreCall = (op, args) => {
  if (core.call == null) {
    throw new ChatCryptoUnavailable(
      core.status.ready ? 'noNativeModule' : core.status.reason
    )
  }
  return core.call(op, args)
}

export function chatCoreStatus(): ChatCoreStatus {
  return core.status
}

export async function loadChatCore(): Promise<ChatCoreStatus> {
  return core.status
}
