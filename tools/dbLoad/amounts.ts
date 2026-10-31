/**
 * How much the fixture seeds at each scale. Every amount the seed uses is here,
 * so another scale is one more entry of this table and nothing else.
 *
 * The population is a tenth of a stress run's. Depths and the numbers of rows
 * that make a shape expensive stay as they are, since a person merged twice
 * is not the shape being tested; the sizes are what a local run cannot afford.
 */
export interface Amounts {
  /** Accounts with a session, which the rig connects as viewers. */
  accounts: number
  /** Publishers: each may hold four cameras on the game of their team. */
  videographers: number
  leagues: number
  seasons: number
  teams: number
  liveGames: number
  /** Finished games written play by play, which the rest are cloned from. */
  writtenFinishedGames: number
  /** Finished games whose stats the builder writes. */
  finishedGames: number
  /** More finished games, cloned for table size alone. */
  historyGames: number
  /** How long each of those is: enough to fill the tables, within the seed's time. */
  historyInnings: number
  /** The share of accounts with a direct message. */
  dmShare: number
  messagesPerDm: number

  mergedRows: number
  chainDepth: number
  guardianChildren: number
  guardianChildDepth: number
  roleTeams: number
  roleSeasons: number
  roleLeagues: number
  largeLeagueSeasons: number
  largeLeagueTeams: number
  duplicateTeams: number
  teamChainDepth: number
  longTeamGames: number
  longGameInnings: number
  crowdedViewers: number
  crowdedWorstCaseViewers: number
  largeChatMembers: number
  largeChatMessages: number
  manyChats: number
  manySessions: number

  /** Fresh copies of each shape an event uses up. */
  consumableCopies: number
  /** People each large-chat event adds. */
  chatAddPeople: number
}

export const SCALES = {
  small: {
    accounts: 500,
    videographers: 5,
    leagues: 2,
    seasons: 2,
    teams: 10,
    liveGames: 5,
    writtenFinishedGames: 3,
    finishedGames: 50,
    historyGames: 800,
    historyInnings: 3,
    dmShare: 0.1,
    messagesPerDm: 2,

    mergedRows: 24,
    chainDepth: 10,
    guardianChildren: 8,
    guardianChildDepth: 5,
    roleTeams: 8,
    roleSeasons: 3,
    roleLeagues: 2,
    largeLeagueSeasons: 2,
    largeLeagueTeams: 30,
    duplicateTeams: 24,
    teamChainDepth: 4,
    longTeamGames: 60,
    longGameInnings: 24,
    crowdedViewers: 60,
    crowdedWorstCaseViewers: 5,
    largeChatMembers: 60,
    largeChatMessages: 1000,
    manyChats: 6,
    manySessions: 20,

    consumableCopies: 3,
    chatAddPeople: 5
  }
} satisfies Record<string, Amounts>

export type Scale = keyof typeof SCALES

export function amountsFor(
  scale: string,
  overrides: Partial<Amounts> = {}
): Amounts {
  if (!Object.hasOwn(SCALES, scale))
    throw new Error(
      `Unknown --scale ${scale}. Scales: ${Object.keys(SCALES).join(', ')}`
    )
  const amounts = { ...SCALES[scale as Scale], ...overrides }
  // A smaller population than the table has in mind still seeds every shape.
  return {
    ...amounts,
    crowdedViewers: Math.min(amounts.crowdedViewers, amounts.accounts),
    largeChatMembers: Math.min(amounts.largeChatMembers, amounts.accounts)
  }
}
