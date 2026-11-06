import { Client } from 'pg'

/** A statement a `pg` client in this process sent, and the backend it went to. */
export interface SentStatement {
  pid: number | null
  text: string
  values: readonly unknown[]
}

interface Options {
  /**
   * Given each statement once its answer has come: a promise the caller waits
   * for before it sees that answer, or nothing. A held answer keeps its
   * connection checked out, between statements, as a slow handler would.
   */
  hold?: (statement: SentStatement) => Promise<void> | undefined
}

/**
 * Runs `work` with every statement this process sends through `pg` recorded,
 * whichever pool or client sends it: the server's, a fixture's or the test's.
 * Mocha runs one test at a time in a process, so nothing else is caught.
 */
export async function recordStatements<T>(
  work: (sent: readonly SentStatement[]) => Promise<T>,
  options: Options = {}
): Promise<{ result: T; sent: SentStatement[] }> {
  const sent: SentStatement[] = []
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Restored below and called through apply with each client.
  const original = Client.prototype.query
  const recording = function (this: Client, ...args: unknown[]): unknown {
    const [config, values] = args as [
      string | { text?: unknown; values?: unknown } | undefined,
      unknown
    ]
    const text = typeof config === 'string' ? config : config?.text
    const answer = (original as (...each: unknown[]) => unknown).apply(
      this,
      args
    )
    if (typeof text !== 'string') return answer
    const statement: SentStatement = {
      pid: (this as unknown as { processID: number | null }).processID,
      text,
      values: Array.isArray(values)
        ? values
        : typeof config === 'object' && Array.isArray(config.values)
          ? config.values
          : []
    }
    sent.push(statement)
    const { hold } = options
    if (hold == null || !(answer instanceof Promise)) return answer
    return answer.then(async result => {
      await hold(statement)
      return result
    })
  }
  Client.prototype.query = recording as unknown as typeof original
  try {
    return { result: await work(sent), sent }
  } finally {
    Client.prototype.query = original
  }
}
