import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'

import type { RecoveryFault } from './chatRecoveryFaults'

export interface RecoveryControl {
  disposable: true
  endpoint: string
  token: string
  actors: Record<string, { userId: string; conversationId: string }>
}

/** Translate the existing native and browser runner protocols exactly. */
export function recoveryControlBody(
  config: RecoveryControl,
  args: string[]
): RecoveryFault | undefined {
  assert.equal(config.disposable, true)
  if (args.length === 1 && args[0] === 'clear') return undefined
  assert(
    args.length === 3 || args.length === 4,
    'Expected actor, action, gateId and optional delay'
  )
  const [actor, action, gateId, delay] = args
  const target = config.actors[actor]
  assert(target != null, 'Only a named synthetic actor may be faulted')
  assert(
    [
      'send',
      'page',
      'empty',
      'delay',
      'success',
      'failure',
      'pending-success',
      'pending-failure',
      'history-delay',
      'history-failure',
      'history-outage',
      'epoch-delay'
    ].includes(action),
    'Unsupported fault action'
  )
  const kind =
    action === 'epoch-delay'
      ? 'epoch'
      : action.startsWith('history-')
        ? 'history'
        : ['page', 'empty', 'delay'].includes(action)
          ? 'page'
          : 'send'
  const outcome =
    action === 'empty'
      ? 'empty'
      : [
            'success',
            'pending-success',
            'delay',
            'history-delay',
            'epoch-delay'
          ].includes(action)
        ? 'success'
        : 'failure'
  const delayMs = delay == null ? 0 : Number(delay)
  assert(Number.isInteger(delayMs) && delayMs >= 0 && delayMs <= 60000)
  // Keep an outage observable while the app makes its normal automatic
  // retries. The owner explicitly clears it; the cap is a failsafe.
  return {
    ...target,
    kind,
    outcome,
    delayMs,
    gateId,
    remaining: action === 'history-outage' ? 100 : 1
  }
}

export async function controlRecovery(
  config: RecoveryControl,
  args: string[]
): Promise<void> {
  const url = new URL(config.endpoint)
  assert.equal(url.protocol, 'http:')
  assert(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
  assert.equal(url.pathname, '/__recovery_fault')
  assert.equal(url.username + url.password + url.search + url.hash, '')
  assert(config.token.length >= 32)
  const body = recoveryControlBody(config, args)
  const response = await fetch(url, {
    method: body == null ? 'DELETE' : 'POST',
    headers: {
      authorization: 'Bearer ' + config.token,
      'content-type': 'application/json'
    },
    ...(body == null ? {} : { body: JSON.stringify(body) }),
    redirect: 'error',
    signal: AbortSignal.timeout(5000)
  })
  assert.equal(
    response.status,
    204,
    'Fault controller rejected the scoped operation'
  )
}

/**
 * The runners' control executable (`scripts/chat-history-recovery-control.cjs`):
 * the arguments as they pass them, and its private settings from `file`.
 */
export async function runRecoveryControl(
  file: string | undefined,
  args: string[]
): Promise<void> {
  assert(
    file != null && isAbsolute(file),
    'CHAT_RECOVERY_CONTROL_FILE must name the private control settings'
  )
  await controlRecovery(
    JSON.parse(readFileSync(file, 'utf8')) as RecoveryControl,
    args
  )
}
