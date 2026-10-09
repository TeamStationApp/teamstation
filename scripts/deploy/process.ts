import { type ChildProcess, spawn } from 'node:child_process'
import { once } from 'node:events'
import { constants } from 'node:os'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'

import { redact, redactedTail, rememberEnvironment } from './redact'

const diagnosticLimit = 32 * 1024

/** Redact complete lines before retaining a bounded compiler failure tail. */
class CompilerDiagnostics {
  private tail = ''
  private readonly lines = { stdout: '', stderr: '' }
  private readonly dropping = { stdout: false, stderr: false }
  private readonly decoders = {
    stdout: new StringDecoder('utf8'),
    stderr: new StringDecoder('utf8')
  }

  private readonly secrets: string[]

  constructor(env: NodeJS.ProcessEnv) {
    this.secrets = Object.entries(env)
      .filter(
        ([key, value]) =>
          /password|token|secret|authorization|dsn|private.?key|(^|_)pin($|_)/i.test(
            key
          ) && value != null
      )
      .flatMap(([, value]) => {
        const secret = value!
        return [secret, encodeURIComponent(secret), ...secret.split(/\r?\n/)]
      })
      .filter(secret => secret.length > 2)
      .sort((a, b) => b.length - a.length)
  }

  private retain(line: string): void {
    line = redact(line)
    for (const secret of this.secrets)
      line = line.split(secret).join('[redacted]')
    this.tail = (this.tail + line + '\n').slice(-diagnosticLimit)
  }

  write(stream: 'stdout' | 'stderr', chunk: Buffer): void {
    const pieces = this.decoders[stream].write(chunk).split('\n')
    for (let i = 0; i < pieces.length; i++) {
      if (!this.dropping[stream]) {
        this.lines[stream] += pieces[i]
        if (this.lines[stream].length > diagnosticLimit) {
          this.lines[stream] = ''
          this.dropping[stream] = true
        }
      }
      if (i < pieces.length - 1) {
        if (!this.dropping[stream]) this.retain(this.lines[stream])
        this.lines[stream] = ''
        this.dropping[stream] = false
      }
    }
  }

  finish(): string {
    for (const stream of ['stdout', 'stderr'] as const) {
      this.lines[stream] += this.decoders[stream].end()
      if (this.lines[stream] !== '' && !this.dropping[stream])
        this.retain(this.lines[stream])
    }
    return this.tail.trim()
  }
}

/**
 * What each failed tool wrote, kept off the error itself so that logging or
 * serializing the error can never print it.
 */
const outputs = new WeakMap<DeploymentToolError, string>()

/**
 * A tool that failed. Its name and status are always safe to print. The end
 * of what it wrote may carry the credentials it was given, so it leaves only
 * through `lastLines`, redacted.
 */
export class DeploymentToolError extends Error {
  readonly tool: string
  readonly signal?: NodeJS.Signals
  constructor(
    message: string,
    file: string,
    readonly exitCode?: number,
    signal?: NodeJS.Signals,
    output = ''
  ) {
    super(message)
    const name = path.basename(file)
    this.tool = /^[a-zA-Z0-9._-]+$/.test(name) ? name : 'tool'
    if (signal != null && Object.hasOwn(constants.signals, signal))
      this.signal = signal
    outputs.set(this, output)
  }

  /** The last `count` nonblank lines the tool wrote, redacted. */
  lastLines(count: number): string[] {
    return redactedTail(outputs.get(this) ?? '', count)
  }
}

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
/** How many of a failed tool's last lines the build log shows. */
const reportedLines = 80

/**
 * A failed tool's last lines, redacted and indented, for the log under the
 * line that names the tool and its status. Any other error prints nothing,
 * since its message can carry private configuration. Indented so Mason's
 * one-line results skip them.
 */
export function describeFailure(error: unknown): string[] {
  if (!(error instanceof DeploymentToolError)) return []
  return error.lastLines(reportedLines).map(line => `  | ${line}`)
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
      const diagnostics = new CompilerDiagnostics(command.env ?? {})
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
        diagnostics.write('stdout', chunk)
        if (command.capture === false) return
        if (stdout.length + chunk.length <= 1024 * 1024)
          stdout += chunk.toString()
        else overflow = true
      })
      // Compiler output may contain credentials. It is never printed as it
      // arrives; a failure prints its redacted tail.
      child.stderr.on('data', (chunk: Buffer) => {
        diagnostics.write('stderr', chunk)
        if (command.captureStderr !== true) return
        if (stdout.length + chunk.length <= 1024 * 1024)
          stdout += chunk.toString()
        else overflow = true
      })
      child.stdin.on('error', () => {})
      child.stdin.end(command.input)
      child.once('error', () => {
        reject(
          new DeploymentToolError(
            'Could not start deployment tool',
            command.file
          )
        )
      })
      child.once('close', (code, signal) => {
        this.children.delete(child)
        this.signal.removeEventListener('abort', abort)
        if (killTimer != null) clearTimeout(killTimer)
        if (this.signal.aborted) reject(new Error('Deployment cancelled'))
        else if (code !== 0) {
          const tail = diagnostics.finish()
          const tool = path.basename(command.file)
          const compiler = [
            'gradlew',
            'xcodebuild',
            'cargo',
            'node',
            'npm'
          ].includes(tool)
          const safeTool = /^[a-zA-Z0-9._-]+$/.test(tool) ? tool : 'tool'
          console.error(
            `${safeTool} failed (exit ${code})${!compiler || tail === '' ? '' : `:\n${tail}`}`
          )
          reject(
            new DeploymentToolError(
              'Deployment tool failed',
              command.file,
              code ?? undefined,
              signal ?? undefined,
              tail
            )
          )
        } else if (overflow)
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
