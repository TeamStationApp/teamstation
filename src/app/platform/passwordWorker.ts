import { argon2id } from 'hash-wasm'

import { nativePasswordKdf } from './passwordKdfNative'

// The same byte adapter ensures WASM and compiled mobile code receive identical inputs.
self.onmessage = async event => {
  try {
    const hash = await nativePasswordKdf(
      event.data.password,
      event.data.parameters,
      async p =>
        await argon2id({
          password: p.password,
          salt: p.salt,
          memorySize: p.memory,
          iterations: p.iterations,
          parallelism: p.parallelism,
          hashLength: p.hashLength,
          outputType: 'binary'
        })
    )
    self.postMessage({ hash })
  } catch {
    self.postMessage({ error: true })
  }
}
