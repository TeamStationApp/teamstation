import { randomBytes } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import type { Kysely } from 'kysely'

import type { Database } from '../server/db/database'
import {
  PushQueue,
  type PushQueueClient,
  pushQueueClient
} from '../server/push/queue'
import type { NewPushRequest } from '../server/push/requests'
import { firstTry } from '../server/push/requests'
import type { PushReport, PushTransports } from '../server/push/send'
import { type SenderDeps, settleEntry } from '../server/push/sender/main'
import { quiet, requireRedis, testRedisUrl } from './scoreboardKit'

/**
 * A key prefix of this run's own, outside `ts-test:`: the scoreboard suites
 * drop every `ts-test:` key when they finish, in the middle of these cases
 * when they run beside them.
 */
export function pushTestPrefix(): string {
  return `ts-push-test:${randomBytes(6).toString('hex')}`
}

/**
 * The push queue on the test Valkey (`TS_TEST_REDIS_URL`) under a prefix of
 * its own, and a sender that drains it in step with a test: what the API
 * queues is read back, done and settled by the push sender's own code.
 */
export interface TestPushQueue {
  queue: PushQueue
  client: PushQueueClient
  prefix: string
  /** Queues a request's first try, as the API does. */
  add: (request: NewPushRequest) => Promise<string>
  /**
   * Reads and settles everything queued, as the sender does, and answers
   * what each piece of work sent.
   */
  drain: (deps: SenderDeps, consumer?: string) => Promise<PushReport[]>
  close: () => Promise<void>
}

/** Connects a queue on a fresh prefix; fails when Valkey is not there. */
export async function testPushQueue(): Promise<TestPushQueue> {
  await requireRedis()
  const prefix = pushTestPrefix()
  const client = pushQueueClient(
    {
      redis: { url: testRedisUrl, prefix },
      databaseUrl: 'postgres://localhost/unused'
    },
    10_000,
    quiet
  )
  await client.connect()
  const queue = new PushQueue(client, prefix)
  await queue.ensureGroup()
  return {
    queue,
    client,
    prefix,
    add: async request => await queue.add(firstTry(request)),
    drain: async (deps, consumer = 'test-sender') => {
      await queue.ensureGroup()
      const reports: PushReport[] = []
      for (;;) {
        const entries = await queue.read(consumer, 100, 1)
        if (entries.length === 0) return reports
        for (const report of await Promise.all(
          entries.map(async entry => await settleEntry(queue, entry, deps))
        ))
          if (report != null) reports.push(report)
      }
    },
    close: async () => {
      const keys = await client.keys(`${prefix}:*`)
      if (keys.length > 0) await client.del(keys)
      await client.close()
    }
  }
}

/** A sender's dependencies over `db`, with whatever clock the test keeps. */
export function senderDeps(
  db: Kysely<Database>,
  transports: PushTransports,
  options: {
    iosFiltering?: boolean
    /** No hold unless a case asks for one, so a drain sends at once. */
    chatHoldMs?: number
    clock?: () => Date
    log?: (line: string) => void
  } = {}
): SenderDeps {
  return {
    db,
    transports,
    iosFiltering: options.iosFiltering ?? false,
    chatHoldMs: options.chatHoldMs ?? 0,
    clock: options.clock ?? (() => new Date()),
    log: options.log ?? quiet
  }
}

/** The transcripts a run writes, each a proving artifact of the plan's. */
const TRANSCRIPTS = {
  queue: 'push-queue-sender.log',
  seen: 'seen-hold-skip.log'
}

/**
 * With `TS_PUSH_TRANSCRIPTS=<dir>`, appends `line` to that directory's
 * transcript of the queue's lifecycle or of the seen-message hold.
 */
export function transcript(name: keyof typeof TRANSCRIPTS, line: string): void {
  const dir = process.env.TS_PUSH_TRANSCRIPTS
  if (dir == null || dir === '') return
  mkdirSync(dir, { recursive: true })
  appendFileSync(join(dir, TRANSCRIPTS[name]), `${line}\n`)
}
