import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'

import { BlockedError, HarnessError } from './result'
import type { LocalSettings } from './settings'

/**
 * Reading what a test really sent. Every search is targeted and bounded in time, and it
 * opens only a message that search identified. Nothing it reads goes to the run
 * directory, because a code or a link signs somebody in.
 */
export interface MailMessage {
  id: string
  subject: string
  date: Date
}

export type GogRunner = (args: string[]) => string

export function testAddressFor(mailbox: string, label: string): string {
  const at = mailbox.indexOf('@')
  const nonce = randomBytes(4).toString('hex')
  return `${mailbox.slice(0, at)}+${label}-${nonce}@${mailbox.slice(at + 1)}`
}

export function gogRunner(settings: LocalSettings): GogRunner {
  const { gogEnvFile } = settings
  if (gogEnvFile == null) {
    throw new BlockedError(
      'no mail access: set gogEnvFile in the local settings'
    )
  }
  return args =>
    execFileSync(
      '/bin/zsh',
      ['-c', 'source "$0"; exec gog "$@"', gogEnvFile, ...args],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    )
}

/** The `-p` table: id, date, from and subject, in fixed columns. */
export function parseSearch(output: string): MailMessage[] {
  const lines = output.split('\n').filter(Boolean)
  const header = lines[0] ?? ''
  const fromAt = header.indexOf('FROM')
  const subjectAt = header.indexOf('SUBJECT')
  if (fromAt < 0 || subjectAt < 0) return []
  return lines.slice(1).map(line => ({
    id: line.split(/\s+/)[0],
    date: new Date(line.slice(line.indexOf(' ') + 1, fromAt).trim() + 'Z'),
    subject: line.slice(subjectAt).trim()
  }))
}

export interface WaitForMail {
  run: GogRunner
  mailbox: string
  to: string
  from: string
  /** A message older than this is from another run, however alike it looks. */
  since: number
  timeoutMs?: number
  stepMs?: number
  now?: () => number
}

const THREE_MINUTES = 180000

export async function waitForMail(options: WaitForMail): Promise<MailMessage> {
  const { run, mailbox, to, from, since } = options
  const now = options.now ?? Date.now
  const end = now() + (options.timeoutMs ?? THREE_MINUTES)
  for (;;) {
    const output = run([
      'gmail',
      'search',
      `to:${to} from:${from} newer_than:15m`,
      '-a',
      mailbox,
      '--max',
      '3',
      '-p'
    ])
    const fresh = parseSearch(output).find(
      message => message.date.getTime() >= since - 60000
    )
    if (fresh != null) return fresh
    if (now() >= end) {
      throw new HarnessError(
        `No mail to ${to} after ${Math.round((options.timeoutMs ?? THREE_MINUTES) / 1000)}s: possibly the provider`
      )
    }
    await new Promise(resolve => setTimeout(resolve, options.stepMs ?? 5000))
  }
}

/** The body of a message the search above identified, for this scenario's memory only. */
export function readMail(run: GogRunner, mailbox: string, id: string): string {
  return run(['gmail', 'read', id, '-a', mailbox])
}
