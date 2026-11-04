export type SendReadiness =
  | 'ready'
  | 'canStartFresh'
  | 'needsDeviceSetup'
  | 'unsupportedServer'
  | 'freshStartsDisabled'
  | 'readOnly'
  | 'closed'
  | 'unverified'
  | 'repairRequired'
export type HistoryRecovery =
  | 'none'
  | 'waitingForHolder'
  | 'awaitingApproval'
  | 'recovering'
  | 'partial'
  | 'retryableError'

export function sendReadinessOf(input: {
  linked: boolean
  closed: boolean
  canPost: boolean
  verified: boolean
  latest: number
  holdsLatest: boolean
  noHolder: boolean
  recoverySupported: boolean
  freshEnabled: boolean
  hasServerBox: boolean
}): SendReadiness {
  if (!input.linked) return 'needsDeviceSetup'
  if (input.closed) return 'closed'
  if (!input.canPost) return 'readOnly'
  if (!input.verified) return 'unverified'
  if (input.latest === 0 || input.holdsLatest || input.noHolder) return 'ready'
  if (!input.recoverySupported) return 'unsupportedServer'
  if (input.hasServerBox) return 'repairRequired'
  return input.freshEnabled ? 'canStartFresh' : 'freshStartsDisabled'
}
