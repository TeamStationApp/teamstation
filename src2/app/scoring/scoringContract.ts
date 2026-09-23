import {
  asEstimatedGumboPlay,
  type EstimatedGumboPlay
} from './contracts/estimatedGumbo'

export type ScoringPlay = EstimatedGumboPlay
export const asScoringPlay = asEstimatedGumboPlay
export type PlayerRef = ScoringPlay['matchup']['batter']
export const outcomeEvents = {
  Single: 'single',
  Double: 'double',
  Triple: 'triple',
  'Home Run': 'home_run',
  "Fielder's Choice": 'fielders_choice',
  Error: 'field_error',
  'Throw Out': 'field_out',
  'Ball Caught': 'field_out',
  'Batter Interference': 'field_out'
} as const
export type Outcome = keyof typeof outcomeEvents
