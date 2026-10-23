import { extname } from 'node:path'
import {
  isMainThread,
  parentPort,
  Worker,
  workerData
} from 'node:worker_threads'

import { buildOptions } from '../../common/autoScheduler'
import type {
  EngineInput,
  EngineResult
} from '../../common/autoScheduler/types'

/** What this file's worker is given. */
interface BuildJob {
  autoSchedulerBuild: EngineInput
}

/** The longest a build may run before it is stopped. */
const BUILD_TIMEOUT_MS = 2 * 60 * 1000

/** The builds asked for, run one at a time. */
let queue: Promise<unknown> = Promise.resolve()

/**
 * Runs the engine on a worker thread, so the server goes on serving while a
 * large league's schedule is built. Builds take their turn one after
 * another, and one that runs too long is stopped. Run from source, the
 * worker compiles TypeScript as this process does.
 */
export async function buildOffThread(
  input: EngineInput,
  timeoutMs = BUILD_TIMEOUT_MS
): Promise<EngineResult> {
  const turn = queue.then(async () => await runWorker(input, timeoutMs))
  queue = turn.catch(() => undefined)
  return await turn
}

async function runWorker(
  input: EngineInput,
  timeoutMs: number
): Promise<EngineResult> {
  const job: BuildJob = { autoSchedulerBuild: input }
  const worker = new Worker(__filename, {
    workerData: job,
    execArgv:
      extname(__filename) === '.ts'
        ? ['-r', require.resolve('sucrase/register')]
        : []
  })
  return await new Promise((resolve, reject) => {
    let settled = false
    const settle = (finish: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      finish()
    }
    const timer = setTimeout(() => {
      settle(() => {
        reject(new Error('The schedule build took too long'))
      })
      worker.terminate().catch(() => undefined)
    }, timeoutMs)
    worker.once('message', (result: EngineResult) => {
      settle(() => {
        resolve(result)
      })
    })
    worker.once('error', error => {
      settle(() => {
        reject(error)
      })
    })
    // An exit before the answer, whatever its code, is a failed build.
    worker.once('exit', code => {
      settle(() => {
        reject(new Error(`The schedule build stopped with code ${code}`))
      })
    })
  })
}

// Started as the worker above: build, answer, and end.
const job = isMainThread ? undefined : (workerData as BuildJob | undefined)
if (job?.autoSchedulerBuild != null)
  parentPort?.postMessage(buildOptions(job.autoSchedulerBuild))
