import { createHash } from 'node:crypto'
import { hostname } from 'node:os'

/**
 * Who a stack belongs to: the machine, by the same hash of its host name the
 * test database's templates use, and the process that started it. Written
 * once by `ownerText` and read only by `judgeOwner`, wherever it is kept: a
 * stack's directory and its database's comment.
 */
export interface StackOwner {
  host: string
  pid: number
}

export function thisHost(): string {
  return createHash('sha256').update(hostname()).digest('hex').slice(0, 6)
}

export function ownerText(
  owner: StackOwner = { host: thisHost(), pid: process.pid }
): string {
  return `e2e stack of host ${owner.host} pid ${owner.pid}`
}

const OWNER = /^e2e stack of host ([0-9a-f]{6}) pid ([1-9][0-9]*)$/

/**
 * Whether what a stack's owner left can go. Only a stack of this machine's
 * whose process is not running is `gone`: one of another machine's, sharing
 * the test cluster, is not this machine's to judge, and one whose owner
 * cannot be read is kept and said so rather than guessed at.
 */
export type OwnerVerdict = 'gone' | 'running' | 'elsewhere' | 'unreadable'

export function judgeOwner(
  text: string | null | undefined,
  alive: (pid: number) => boolean,
  host = thisHost()
): OwnerVerdict {
  const found = OWNER.exec((text ?? '').trim())
  if (found == null) return 'unreadable'
  if (found[1] !== host) return 'elsewhere'
  return alive(Number(found[2])) ? 'running' : 'gone'
}

/** A registry entry's pid, which is always this machine's: the same test. */
export function judgePid(
  pid: unknown,
  alive: (pid: number) => boolean
): OwnerVerdict {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid < 1) {
    return 'unreadable'
  }
  return alive(pid) ? 'running' : 'gone'
}
