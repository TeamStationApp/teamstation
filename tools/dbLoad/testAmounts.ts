import type { Amounts } from './amounts'

/** The table's own shapes, with its populations cut down for a test's time. */
export const TEST_AMOUNTS = {
  accounts: 40,
  crowdedViewers: 10,
  historyGames: 5,
  finishedGames: 4,
  writtenFinishedGames: 2,
  largeChatMembers: 10,
  largeChatMessages: 12,
  longTeamGames: 4
} satisfies Partial<Amounts>
