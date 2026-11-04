import { lstrings } from '../locales/strings'
import type { ConversationView } from './engine/engine'

/** History availability never determines whether the composer is enabled. */
export function historyStatusText(
  view: Pick<ConversationView, 'historyRecovery' | 'sendReadiness'>
): string {
  switch (view.historyRecovery) {
    case 'awaitingApproval':
      return lstrings.chat_history_approval
    case 'partial':
      return lstrings.chat_history_partial
    case 'retryableError':
      return lstrings.chat_history_retry
    case 'recovering':
      return lstrings.chat_history_recovering
    default:
      return view.sendReadiness === 'unsupportedServer'
        ? lstrings.chat_history_legacy
        : lstrings.chat_history_waiting
  }
}

export function sendStatusText(
  readiness: ConversationView['sendReadiness']
): string | undefined {
  switch (readiness) {
    case 'freshStartsDisabled':
      return lstrings.chat_fresh_disabled
    case 'unsupportedServer':
      return lstrings.chat_history_legacy
    case 'repairRequired':
      return lstrings.chat_keys_repair
    default:
      return undefined
  }
}
