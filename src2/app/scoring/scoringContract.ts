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
export type ContactKind = 'swing' | 'bunt'
export type Outcome = keyof typeof outcomeEvents

export const moreEvents = {
  'Wild Pitch': 'wild_pitch',
  'Passed Ball': 'passed_ball',
  Balk: 'balk',
  'Put Batter on Base': 'manual_placement',
  'Batter Out — Other': 'field_out',
  'Place a Runner (Tiebreaker)': 'placed_runner',
  'Hit by Pitch': 'hit_by_pitch',
  'Intentional Walk': 'intent_walk',
  "Catcher's Interference": 'catcher_interference',
  'Dropped Third Strike': 'strikeout'
} as const
