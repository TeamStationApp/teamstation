import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import type { SpaceSettings } from '../../../src/server/media/spacesHls'
import { BlockedError } from '../../core/result'
import type { E2eContext } from '../../core/spec'
import {
  requireStreamingHandle,
  SSH_OPTIONS,
  type StreamingHandle
} from '../../core/streamingStack'

const run = promisify(execFile)

/** Where a stack's droplet runs the branch, built, with its own config. */
export const STACK_APP = '/srv/e2e/app'

/** The attached stack's handle, or blocked: these scenarios need a droplet. */
export function stackHandle(ctx: E2eContext): StreamingHandle {
  const attached = ctx.stack.attached
  if (attached == null) {
    throw new BlockedError('needs an attached e2e stack (--stack <id>)')
  }
  return requireStreamingHandle(attached)
}

function sshArgs(handle: StreamingHandle): string[] {
  const key = handle.sshKeyFile
  return [
    ...SSH_OPTIONS,
    ...(typeof key === 'string' && key !== '' ? ['-i', key] : []),
    handle.ssh
  ]
}

/** Runs a shell command on the stack's droplet and answers its output. */
export async function onStack(
  handle: StreamingHandle,
  command: string,
  options: { timeoutMs?: number } = {}
): Promise<string> {
  const { stdout } = await run('ssh', [...sshArgs(handle), command], {
    maxBuffer: 1 << 26,
    timeout: options.timeoutMs ?? 600_000
  })
  return stdout
}

/**
 * The stack's own Space, read out of the droplet's server config into memory.
 * Never logged or written anywhere: it carries the Space's secret key.
 */
export async function stackSpace(
  handle: StreamingHandle
): Promise<SpaceSettings> {
  const text = await onStack(handle, `cat ${STACK_APP}/serverConfig.json`)
  const space = (JSON.parse(text) as { space?: SpaceSettings }).space
  if (space?.bucket == null || space.bucket === '') {
    throw new BlockedError('the stack has no Space configured')
  }
  return space
}
