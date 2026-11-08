import type { SavedUndone } from './scoringMachine'
import type { ScoringEvent } from './scoringTypes'

/** Animation and save callbacks do not turn an observer into a scorer. */
export function authoredScoringEvent(
  event: ScoringEvent | SavedUndone
): boolean {
  switch (event.type) {
    case 'RESET':
    case 'SAVED_UNDONE':
    case 'PRESENTATION':
    case 'PRESENTATION_CONTACT':
    case 'PRESENTATION_DONE':
    case 'MOTION_DONE':
    case 'TIMER_TICK':
    case 'CELEBRATION_DONE':
      return false
    case 'CLOSE_PLAY':
      return event.generation == null
    case 'GESTURE':
      return event.active
    default:
      return true
  }
}

/** Separates adopted remote progress from unfinished input on this screen. */
export class ScoringFollow {
  private generation = 0
  observing = false
  locallyAuthored = false
  mounted = true

  authored(): void {
    this.generation++
    this.observing = false
    this.locallyAuthored = true
  }

  snapshot(): number {
    return this.generation
  }

  current(generation: number): boolean {
    return this.mounted && generation === this.generation
  }

  adopt(generation: number): boolean {
    if (!this.current(generation)) return false
    this.observing = true
    this.locallyAuthored = false
    return true
  }

  dispose(): void {
    this.mounted = false
    this.generation++
  }
}
