import { extname } from 'node:path'
import {
  isMainThread,
  parentPort,
  Worker,
  workerData
} from 'node:worker_threads'

import { InvalidSubmission } from '../../common/autoScheduler/context'
import type { EngineResult } from '../../common/autoScheduler/types'
import { summarizeResult } from '../../common/autoScheduler/validateResult'
import { badRequest, HttpError, unavailable } from '../../common/errors'
import type { Snapshot } from './snapshot'

interface ValidationJob {
  deviceScheduleValidation: { snap: Snapshot; result: EngineResult }
}
type ValidationReply =
  | { ok: true; result: EngineResult }
  | { ok: false; invalid: boolean; message: string }

let queue: Promise<unknown> = Promise.resolve()
let pending = 0

/** Validate and summarize device output without searching or blocking HTTP work. */
export async function validateOffThread(
  snap: Snapshot,
  result: EngineResult,
  timeoutMs = 30000
): Promise<EngineResult> {
  // Busy is the one refusal worth sending the same result again for.
  if (pending >= 4)
    throw new HttpError(
      'unavailable',
      'Schedule validation is busy. Try again shortly.',
      { retry: true }
    )
  pending++
  const turn = queue.then(
    async () =>
      await runValidation(
        { deviceScheduleValidation: { snap, result } },
        timeoutMs
      )
  )
  queue = turn.catch(() => undefined)
  try {
    return await turn
  } finally {
    pending--
  }
}

async function runValidation(
  job: ValidationJob,
  timeoutMs: number
): Promise<EngineResult> {
  const worker = new Worker(__filename, {
    workerData: job,
    resourceLimits: { maxOldGenerationSizeMb: 256 },
    execArgv:
      extname(__filename) === '.ts'
        ? ['-r', require.resolve('sucrase/register')]
        : []
  })
  return await new Promise((resolve, reject) => {
    let settled = false
    const finish = (work: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      worker.terminate().then(work, work)
    }
    const timer = setTimeout(() => {
      finish(() => {
        reject(
          unavailable('Schedule validation took too long. Try a smaller run.')
        )
      })
    }, timeoutMs)
    worker.once('message', (reply: ValidationReply) => {
      finish(() => {
        if (reply.ok) resolve(reply.result)
        else
          reject(
            reply.invalid
              ? badRequest(reply.message)
              : unavailable('Schedule validation failed. Try again.')
          )
      })
    })
    worker.once('error', (error: Error & { code?: string }) => {
      finish(() => {
        reject(
          unavailable(
            error.code === 'ERR_WORKER_OUT_OF_MEMORY'
              ? 'Schedule validation ran out of memory. Try a smaller run.'
              : 'Schedule validation stopped. Try a smaller run.'
          )
        )
      })
    })
    worker.once('exit', () => {
      finish(() => {
        reject(
          unavailable(
            'Schedule validation stopped before returning a result. Try again.'
          )
        )
      })
    })
  })
}

const job = isMainThread ? undefined : (workerData as ValidationJob | undefined)
if (job?.deviceScheduleValidation != null) {
  const { snap, result } = job.deviceScheduleValidation
  // Dynamic import keeps the worker entry independent of the route module's initialization.
  import('./placementChecks')
    .then(({ validatePlacements }) => {
      validatePlacements(snap, result)
      return summarizeResult(snap.engine, result)
    })
    .then(
      result =>
        parentPort?.postMessage({ ok: true, result } satisfies ValidationReply),
      (error: unknown) =>
        parentPort?.postMessage({
          ok: false,
          invalid:
            error instanceof InvalidSubmission ||
            (error instanceof HttpError && error.code === 'badRequest'),
          message: error instanceof Error ? error.message : 'Validation failed'
        } satisfies ValidationReply)
    )
}
