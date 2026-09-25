import type { ContactKind, Outcome } from './scoringContract'
export interface OutcomePickerProps {
  contactKind?: ContactKind
  hasRunners?: boolean
  disabled: boolean
  onChoose: (outcome: Outcome) => void
  onActive: (active: boolean) => void
}
