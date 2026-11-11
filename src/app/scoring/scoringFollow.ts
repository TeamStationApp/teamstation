import type { SavedUndone } from './scoringMachine'
import type { ScoringEvent } from './scoringTypes'

/** Animation and save callbacks do not turn an observer into a scorer. */
export function authoredScoringEvent(
  event: ScoringEvent | SavedUndone
): boolean {
  switch (event.type) {
    case 'RESET':
    case 'PLANS':
    case 'SAVED_UNDONE':
    case 'PRESENTATION':
    case 'PRESENTATION_CONTACT':
    case 'PRESENTATION_DONE':
    case 'MOTION_DONE':
    case 'TIMER_TICK':
    case 'CELEBRATION_DONE':
      return false
    case 'CLOSE_PLAY':
      return event.authored === true || event.generation == null
    case 'GESTURE':
      return false
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

  input(event: ScoringEvent | SavedUndone): boolean {
    // A held pointer invalidates a pending read, but a canceled drag has
    // authored no scoring. Keep observing until a scoring action commits.
    if (event.type === 'GESTURE' && event.active) this.generation++
    const authored = authoredScoringEvent(event)
    if (authored) this.authored()
    return authored
  }

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
