import { type ChildProcess, spawn } from 'node:child_process'
import { once } from 'node:events'
import path from 'node:path'

import { redactedTail, rememberEnvironment } from './redact'

/** Only explicit nonsecret environment values reach compilers; signing adapters add their own. */
export function childEnvironment(
  extra: NodeJS.ProcessEnv = {}
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { LANG: 'en_US.UTF-8', CI: '1' }
  for (const key of [
    'PATH',
    'HOME',
    'USER',
    'TMPDIR',
    'DEVELOPER_DIR',
    'JAVA_HOME',
    'ANDROID_HOME',
    'ANDROID_SDK_ROOT',
    'SSH_AUTH_SOCK'
  ])
    if (process.env[key] != null) out[key] = process.env[key]
  return { ...out, ...extra }
}
export interface Command {
  file: string
  args: string[]
  cwd: string
  env?: NodeJS.ProcessEnv
  input?: string
  capture?: boolean
  captureStderr?: boolean
}
/** How much of a tool's latest output is kept, unprinted, for its failure. */
const tailLimit = 64 * 1024

/**
 * A tool that exited with an error. Its output is kept so the failure can say
 * why, but only `redactedTail` (`./redact`) may print it.
 */
export class ToolFailure extends Error {
  constructor(
    readonly tool: string,
    readonly code: number | null,
    readonly output: string
  ) {
    super('Deployment tool failed')
  }
}

/** How many of a failed tool's last lines the build log shows. */
const reportedLines = 80

/**
 * Why a step failed, as indented log lines: a tool's name, exit code and last
 * lines, all redacted. Any other error prints nothing, since its message can
 * carry private configuration. Indented so Mason's one-line results skip them.
 */
export function describeFailure(error: unknown): string[] {
  if (!(error instanceof ToolFailure)) return []
  const lines = redactedTail(error.output, reportedLines)
  return [
    `  ${error.tool} exited with ${error.code ?? 'a signal'}${
      lines.length > 0 ? '; its last lines:' : ' and printed nothing'
    }`,
    ...lines.map(line => `  | ${line}`)
  ]
}

export class Processes {
  private readonly children = new Set<ChildProcess>()
  constructor(readonly signal: AbortSignal) {}
  async run(command: Command): Promise<string> {
    this.signal.throwIfAborted()
    return await new Promise((resolve, reject) => {
      const child = spawn(command.file, command.args, {
        cwd: command.cwd,
        env: childEnvironment(command.env),
        stdio: 'pipe',
        detached: true
      })
      this.children.add(child)
      rememberEnvironment(command.env)
      let stdout = ''
      let tail = ''
      const keep = (chunk: Buffer): void => {
        tail = (tail + chunk.toString()).slice(-tailLimit)
      }
      let overflow = false
      let killTimer: NodeJS.Timeout | undefined
      function kill(signal: NodeJS.Signals): void {
        if (child.pid != null) {
          try {
            process.kill(-child.pid, signal)
          } catch {
            /* Already exited. */
          }
        }
      }
      const abort = (): void => {
        kill('SIGTERM')
        killTimer = setTimeout(() => {
          kill('SIGKILL')
        }, 3000)
        killTimer.unref()
      }
      this.signal.addEventListener('abort', abort, { once: true })
      child.stdout.on('data', (chunk: Buffer) => {
        keep(chunk)
        if (command.capture === false) return
        if (stdout.length + chunk.length <= 1024 * 1024)
          stdout += chunk.toString()
        else overflow = true
      })
      // Compiler output may contain credentials. It is never printed as it
      // arrives; a failure prints its redacted tail.
      child.stderr.on('data', (chunk: Buffer) => {
        keep(chunk)
        if (command.captureStderr !== true) return
        if (stdout.length + chunk.length <= 1024 * 1024)
          stdout += chunk.toString()
        else overflow = true
      })
      child.stdin.on('error', () => {})
      child.stdin.end(command.input)
      child.once('error', () => {
        reject(new Error('Could not start deployment tool'))
      })
      child.once('close', code => {
        this.children.delete(child)
        this.signal.removeEventListener('abort', abort)
        if (killTimer != null) clearTimeout(killTimer)
        if (this.signal.aborted) reject(new Error('Deployment cancelled'))
        else if (code !== 0)
          reject(new ToolFailure(path.basename(command.file), code, tail))
        else if (overflow)
          reject(new Error('Deployment tool output exceeded limit'))
        else resolve(stdout.trim())
      })
      if (this.signal.aborted) abort()
    })
  }

  async inhibit(file: string, cwd: string): Promise<() => void> {
    this.signal.throwIfAborted()
    const child = spawn(file, ['-dimsu', '-w', String(process.pid)], {
      cwd,
      env: childEnvironment(),
      stdio: 'ignore'
    })
    await once(child, 'spawn')
    return () => {
      child.kill('SIGTERM')
    }
  }
}
