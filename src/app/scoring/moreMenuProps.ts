import type { MoreInput } from './moreActions'
import type { ScoringState } from './scoringTypes'
export interface MoreMenuProps {
  state: ScoringState
  disabled: boolean
  onActive: (active: boolean) => void
  onChoose: (input: MoreInput) => void
}
