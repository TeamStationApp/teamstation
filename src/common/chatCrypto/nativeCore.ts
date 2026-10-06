import {
  type ChatCoreStatus,
  type CoreCall,
  makeCall,
  selfTest
} from './coreCall'

/**
 * The chat crypto core over the phones' `NativeChatCrypto` TurboModule (or
 * anything shaped like it): an op and its encoded arguments in an
 * `ArrayBuffer`, the encoded answer back in another. `core.native.ts` binds it
 * to the real module; the tests bind it to a stand-in.
 */
export interface NativeCoreModule {
  call: (op: number, input: object) => object
}

/** The core over a native module, or why there is none. */
export function coreOf(module: NativeCoreModule | null | undefined): {
  status: ChatCoreStatus
  call: CoreCall | undefined
} {
  if (module == null) {
    return {
      status: { ready: false, reason: 'noNativeModule' },
      call: undefined
    }
  }
  // `makeCall` passes what `encodeArgs` made: an array over the whole of a
  // buffer of its own, so the buffer itself is the input, with no copy.
  const made = makeCall(
    (op, input) => new Uint8Array(module.call(op, input.buffer) as ArrayBuffer)
  )
  if (!selfTest(made)) {
    return {
      status: { ready: false, reason: 'selfTestFailed' },
      call: undefined
    }
  }
  return { status: { ready: true }, call: made }
}
