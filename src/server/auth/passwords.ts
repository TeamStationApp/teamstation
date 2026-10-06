import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

import { argon2id, hash } from 'argon2'

import { unavailable } from '../../common/errors'
import {
  type ArgonParameters,
  asArgonParameters,
  asClientHash,
  clientParameters,
  DEFAULT_PASSWORD_COSTS,
  passwordBytes
} from '../../common/passwordProtocol'

export interface PasswordRecord {
  schema: 1
  client: ArgonParameters
  server: ArgonParameters
  hash: string
}
export const passwordSalt = (): string => randomBytes(16).toString('hex')
export function readPasswordRecord(
  stored: string | null
): PasswordRecord | null {
  try {
    const raw = JSON.parse(stored ?? '') as PasswordRecord
    if (raw.schema !== 1) return null
    const client = asArgonParameters(raw.client)
    const server = asArgonParameters(raw.server, true)
    if (
      server.memoryKiB !== client.memoryKiB ||
      server.parallelism !== client.parallelism ||
      server.iterations !== client.iterations * 4 ||
      server.salt === client.salt
    )
      return null
    return { schema: 1, client, server, hash: asClientHash(raw.hash) }
  } catch {
    return null
  }
}

/** Bounds memory per worker process; overload fails promptly instead of queuing secrets. */
export class PasswordHasher {
  private busy = false
  constructor(private readonly derive = nativeArgon) {}
  async run(input: Uint8Array, parameters: ArgonParameters): Promise<string> {
    if (this.busy)
      throw unavailable('Password verification is busy. Please try again')
    this.busy = true
    try {
      return await this.derive(input, parameters)
    } finally {
      this.busy = false
    }
  }
}
export async function nativeArgon(
  input: Uint8Array,
  p: ArgonParameters
): Promise<string> {
  const result = await hash(Buffer.from(input), {
    type: argon2id,
    version: p.version,
    memoryCost: p.memoryKiB,
    timeCost: p.iterations,
    parallelism: p.parallelism,
    hashLength: p.hashLength,
    salt: Buffer.from(p.salt, 'hex'),
    raw: true
  })
  return result.toString('hex')
}
const hasher = new PasswordHasher()
export async function createPasswordRecord(
  clientHash: string,
  parameters: ArgonParameters
): Promise<string> {
  const client = asArgonParameters(parameters)
  const input = Buffer.from(asClientHash(clientHash), 'hex')
  const server = {
    ...client,
    iterations: client.iterations * 4,
    salt: passwordSalt()
  }
  try {
    const digest = await hasher.run(input, server)
    return JSON.stringify({
      schema: 1,
      client,
      server,
      hash: digest
    } satisfies PasswordRecord)
  } finally {
    input.fill(0)
  }
}
export async function passwordMatches(
  clientHash: string,
  stored: string | null
): Promise<boolean> {
  const record = readPasswordRecord(stored)
  if (record == null) return false
  const input = Buffer.from(asClientHash(clientHash), 'hex')
  try {
    const actual = await hasher.run(input, record.server)
    return timingSafeEqual(
      Buffer.from(actual, 'hex'),
      Buffer.from(record.hash, 'hex')
    )
  } finally {
    input.fill(0)
  }
}
export function decoyParameters(
  email: string,
  secret: string
): ArgonParameters {
  const salt = createHmac('sha256', secret)
    .update(`password-parameters:${email}`)
    .digest('hex')
    .slice(0, 32)
  return clientParameters(salt)
}

/** Only local development seeds accept plaintext; HTTP routes accept clientHash exclusively. */
export async function hashPassword(password: string): Promise<string> {
  const client = clientParameters(passwordSalt(), DEFAULT_PASSWORD_COSTS)
  const bytes = passwordBytes(password)
  try {
    return await createPasswordRecord(await hasher.run(bytes, client), client)
  } finally {
    bytes.fill(0)
  }
}
