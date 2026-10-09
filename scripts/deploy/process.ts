import { type ChildProcess, spawn } from 'node:child_process'
import { once } from 'node:events'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'

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
    if (
      /(password|token|secret|authorization|dsn|private_key)[^\r\n:=]{0,40}[:=]/i.test(
        line
      )
    ) {
      line = '[redacted sensitive compiler output]'
    } else {
      for (const secret of this.secrets)
        line = line.split(secret).join('[redacted]')
      line = line.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, '$1[redacted]@')
    }
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
export class Processes {
  private readonly children = new Set<ChildProcess>()
  constructor(readonly signal: AbortSignal) {}
  async run(command: Command): Promise<string> {
    this.signal.throwIfAborted()
    return await new Promise((resolve, reject) => {
      const env = childEnvironment(command.env)
      const tool = path.basename(command.file)
      const compiler =
        ['xcodebuild', 'gradlew', 'sentry-cli', 'cargo'].includes(tool) ||
        (tool === 'bundle' &&
          command.args[0] === 'exec' &&
          command.args[1] === 'pod')
      const diagnostics = compiler ? new CompilerDiagnostics(env) : undefined
      const child = spawn(command.file, command.args, {
        cwd: command.cwd,
        env,
        stdio: 'pipe',
        detached: true
      })
      this.children.add(child)
      let stdout = ''
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
        diagnostics?.write('stdout', chunk)
        if (command.capture === false) return
        if (stdout.length + chunk.length <= 1024 * 1024)
          stdout += chunk.toString()
        else overflow = true
      })
      // Successful output and signing-tool output stay private. Only compiler
      // failures print a bounded tail, redacted before it is retained.
      child.stderr.on('data', (chunk: Buffer) => {
        diagnostics?.write('stderr', chunk)
      })
      if (command.captureStderr === true)
        child.stderr.on('data', (chunk: Buffer) => {
          if (stdout.length + chunk.length <= 1024 * 1024)
            stdout += chunk.toString()
          else overflow = true
        })
      else child.stderr.resume()
      child.stdin.on('error', () => {})
      child.stdin.end(command.input)
      child.once('error', () => {
        console.error(`Deployment tool could not start: ${tool}`)
        reject(new Error('Could not start deployment tool'))
      })
      child.once('close', code => {
        this.children.delete(child)
        this.signal.removeEventListener('abort', abort)
        if (killTimer != null) clearTimeout(killTimer)
        if (this.signal.aborted) reject(new Error('Deployment cancelled'))
        else if (code !== 0) {
          const tail = diagnostics?.finish()
          console.error(
            `${tool} failed (exit ${code})${tail == null || tail === '' ? '' : `:\n${tail}`}`
          )
          reject(new Error('Deployment tool failed'))
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
