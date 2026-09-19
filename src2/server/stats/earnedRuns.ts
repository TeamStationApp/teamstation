export interface PitcherEarnedRuns {
  er: number
}

export interface EarnedRunTrace {
  runnerId: string
  pitcherId: string | null
  teamOuts: number
  pitcherOuts: number
  charged: boolean
  half: string
  /** The runner list as it stood, newest first. */
  runners: string
}
