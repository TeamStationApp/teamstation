import {
  asArgonParameters,
  asClientHash,
  type PasswordKdf
} from '../../common/passwordProtocol'

declare const TS_PASSWORD_WORKER_URL: string

export function workerPasswordKdf(
  createWorker: () => Worker,
  timeoutMs = 30000
): PasswordKdf {
  return async (password, parameters) => {
    const clean = asArgonParameters(parameters)
    if (password.length > 1024) throw new Error('Password is too long')
    return await new Promise<string>((resolve, reject) => {
      let worker: Worker
      try {
        worker = createWorker()
      } catch {
        reject(
          new Error(
            'Password hashing is unavailable. Use an email code to sign in'
          )
        )
        return
      }
      const finish = (error?: Error, result?: string): void => {
        clearTimeout(timer)
        worker.terminate()
        if (error != null) reject(error)
        else resolve(result!)
      }
      const timer = setTimeout(() => {
        finish(
          new Error(
            'Password hashing timed out. Try again or use an email code'
          )
        )
      }, timeoutMs)
      worker.onmessage = event => {
        try {
          if (event.data?.error != null)
            throw new Error(
              'Password hashing failed. Try again or use an email code'
            )
          finish(undefined, asClientHash(event.data?.hash))
        } catch (error) {
          finish(
            error instanceof Error ? error : new Error('Invalid password hash')
          )
        }
      }
      worker.onerror = () => {
        finish(
          new Error('Password hashing failed. Try again or use an email code')
        )
      }
      try {
        worker.postMessage({ password, parameters: clean })
      } catch {
        finish(
          new Error('Password hashing failed. Try again or use an email code')
        )
      }
    })
  }
}
export const passwordKdf = workerPasswordKdf(
  () => new Worker(TS_PASSWORD_WORKER_URL)
)
