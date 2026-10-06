import { argon2id } from 'hash-wasm'

import { nativePasswordKdf } from '../app/platform/passwordKdfNative'
import { TeamStationClient } from '../common/api'
import { clientParameters, type PasswordKdf } from '../common/passwordProtocol'

export const testPasswordCosts = {
  memoryKiB: 32768,
  iterations: 6,
  parallelism: 4
}
export const testPasswordParameters = clientParameters(
  '000102030405060708090a0b0c0d0e0f',
  testPasswordCosts
)
export const testPasswordKdf: PasswordKdf = async (password, parameters) =>
  await nativePasswordKdf(
    password,
    parameters,
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

/** Shared sign-in for Node-driven browser scenarios; never sends the raw fixture password. */
export async function signInTestAccount(
  baseUrl: string,
  who: { email: string; password: string }
): Promise<string> {
  const client = new TeamStationClient({
    baseUrl,
    passwordKdf: testPasswordKdf
  })
  return (await client.signInWithPassword(who.email, who.password)).token
}
