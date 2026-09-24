import type { Outcome } from './scoringContract'
export interface OutcomePickerProps {
  hasRunners?: boolean
  disabled: boolean
  onChoose: (outcome: Outcome) => void
  onActive: (active: boolean) => void
}
