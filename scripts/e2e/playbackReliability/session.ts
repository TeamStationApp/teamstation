import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { promisify } from 'node:util'

import { argon2id, hash } from 'argon2'

import type { PasswordKdf } from '../../../src/common/passwordProtocol'

const run = promisify(execFile)

/**
 * The account the suite signs in as, and where its password lives: a
 * 1Password item read through `op-scotty` at the moment it is needed, held
 * only in memory, and never printed, logged or passed on a command line.
 */
export interface Account {
  email: string
  /** The 1Password item's id or title. */
  item: string
  vault: string
  /**
   * A test account's own file instead: `{email, password}`, owner-only, made
   * for the run on the server under test. Only such an account may be typed
   * into a phone, whose driver can keep what is typed in its log.
   */
  file?: string
}

/**
 * `TS_ACCOUNT_FILE` for a test account, or else `TS_ACCOUNT_EMAIL`,
 * `TS_ACCOUNT_ITEM` and `TS_ACCOUNT_VAULT`.
 */
export function accountFrom(env: Record<string, string | undefined>): Account {
  const file = env.TS_ACCOUNT_FILE ?? ''
  if (file !== '') {
    const { email } = JSON.parse(readFileSync(file, 'utf8')) as {
      email?: string
    }
    if (email == null || email === '') throw new Error(`${file} has no email`)
    return { email, item: '', vault: '', file }
  }
  const email = env.TS_ACCOUNT_EMAIL ?? ''
  const item = env.TS_ACCOUNT_ITEM ?? ''
  if (email === '' || item === '') {
    throw new Error('TS_ACCOUNT_EMAIL and TS_ACCOUNT_ITEM are required')
  }
  return { email, item, vault: env.TS_ACCOUNT_VAULT ?? 'Teamstation' }
}

/** The item's password field. */
export async function passwordOf(
  account: Account,
  exec: (
    program: string,
    args: string[]
  ) => Promise<{ stdout: string }> = async (program, args) =>
    await run(program, args, { maxBuffer: 1 << 22 })
): Promise<string> {
  if (account.file != null) {
    const { password } = JSON.parse(readFileSync(account.file, 'utf8')) as {
      password?: string
    }
    if (password == null || password === '')
      throw new Error(`${account.file} has no password`)
    return password
  }
  const { stdout } = await exec(process.env.OP_CLI ?? 'op-scotty', [
    'item',
    'get',
    account.item,
    '--vault',
    account.vault,
    '--format',
    'json',
    '--reveal'
  ])
  const fields =
    (
      JSON.parse(stdout) as {
        fields?: Array<{ purpose?: string; value?: string }>
      }
    ).fields ?? []
  const value = fields.find(field => field.purpose === 'PASSWORD')?.value
  if (value == null || value === '')
    throw new Error(`${account.item} has no password`)
  return value
}

/** The server's client-side password hash, computed the way the app does in Node. */
export const nodePasswordKdf: PasswordKdf = async (password, parameters) =>
  (
    await hash(password, {
      type: argon2id,
      raw: true,
      version: parameters.version,
      memoryCost: parameters.memoryKiB,
      timeCost: parameters.iterations,
      parallelism: parameters.parallelism,
      hashLength: parameters.hashLength,
      salt: Buffer.from(parameters.salt, 'hex')
    })
  ).toString('hex')
