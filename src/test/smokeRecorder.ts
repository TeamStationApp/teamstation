import type { ChildProcess } from 'node:child_process'

/** Retain cleanup even if recording starts but its acknowledgement is lost. */
export function androidSmokeRecording(
  driver: { start: () => Promise<unknown>; stop: () => Promise<unknown> },
  removeOwnedFile: () => void
): {
  start: () => Promise<void>
  stop: () => Promise<void>
  dispose: () => Promise<void>
} {
  let active = false
  let needsCleanup = false
  const stop = async (): Promise<void> => {
    if (!active) return
    await driver.stop()
    active = false
  }
  return {
    async start() {
      active = true
      needsCleanup = true
      await driver.start()
    },
    stop,
    async dispose() {
      if (!needsCleanup) return
      try {
        await stop()
      } finally {
        removeOwnedFile()
        needsCleanup = false
      }
    }
  }
}

/** Observe immediately: a recorder that exits before cleanup must never hang it. */
export function watchSmokeRecorder(child: ChildProcess): {
  completion: Promise<void>
  stop: () => Promise<void>
} {
  let stopping = false
  const completion = new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (stopping && (code === 0 || (code == null && signal === 'SIGINT')))
        resolve()
      else reject(new Error(`Recorder exited unexpectedly (${code ?? signal})`))
    })
  })
  // The process may fail while UI commands are pending; preserve its rejection
  // for the caller without an unhandled rejection in the meantime.
  completion.catch(() => undefined)
  return {
    completion,
    async stop() {
      if (child.exitCode == null && child.signalCode == null) {
        stopping = true
        child.kill('SIGINT')
      }
      await completion
    }
  }
}
