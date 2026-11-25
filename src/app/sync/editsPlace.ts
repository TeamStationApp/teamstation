/**
 * Where the web keeps unsent edits, as its screens name it: this tab's own
 * copy, which closing the tab loses. The phone's is `editsPlace.native.ts`.
 */
export const EDITS_PLACE = {
  /** "1 change in this tab has not been sent". */
  on: 'in this tab',
  /** "what was scored in this tab", the place's own words. */
  scored: 'what was scored in this tab for this game and has not been sent',
  /** "the players added in this tab". */
  playersAdded: 'the players added in this tab',
  /** "The changes made in this tab to the game". */
  changes: 'The changes made in this tab',
  /** "Try again once you're back online." */
  backOnline: "you're back online",
  /** "This game is not in this tab yet": a game this copy has not stored. */
  stored: 'in this tab',
  /** "was taken out of this tab": a player a given-up create made. */
  takenOff: 'out of this tab'
}
