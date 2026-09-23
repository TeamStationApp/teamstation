import type { Outcome } from './scoringContract'
export interface OutcomePickerProps {
  disabled: boolean
  onChoose: (outcome: Outcome) => void
  onActive: (active: boolean) => void
}
