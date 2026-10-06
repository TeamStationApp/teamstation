import {
  type ArgonParameters,
  asArgonParameters,
  bytesHex,
  hexBytes,
  passwordBytes
} from '../../common/passwordProtocol'

export interface NativeArgonInput {
  password: Uint8Array
  salt: Uint8Array
  memory: number
  iterations: number
  parallelism: number
  hashLength: number
  version: number
}
export async function nativePasswordKdf(
  password: string,
  parameters: ArgonParameters,
  derive: (input: NativeArgonInput) => Promise<Uint8Array>
): Promise<string> {
  const p = asArgonParameters(parameters)
  if (password.length > 1024) throw new Error('Password is too long')
  const bytes = passwordBytes(password)
  if (bytes.length > 1024) throw new Error('Password is too long')
  try {
    const result = await derive({
      password: bytes,
      salt: hexBytes(p.salt),
      memory: p.memoryKiB,
      iterations: p.iterations,
      parallelism: p.parallelism,
      hashLength: p.hashLength,
      version: p.version
    })
    if (result.length !== 32)
      throw new Error('Password hashing returned an invalid result')
    const encoded = bytesHex(result)
    result.fill(0)
    return encoded
  } finally {
    bytes.fill(0)
  }
}
