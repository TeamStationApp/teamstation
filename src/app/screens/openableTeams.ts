/**
 * Which of a game's two sides have a team page behind them.
 *
 * A name on the card answers a press only where there is somewhere to go.
 * Two lists say there is: the teams this person belongs to, which they can
 * always open, and the teams of the season the game was played in, which a
 * season they are allowed to watch lets them open as well. An opponent from
 * outside the season is in neither, and its name stays a name.
 *
 * Both sides are looked up before either is drawn, so a name either answers a
 * press or never did — rather than answering it a beat later by doing nothing.
 */
export function openableTeams<Team extends { id: string }>(
  lists: readonly Team[][],
  sides: readonly string[]
): Map<string, Team> {
  const found = new Map<string, Team>()
  for (const list of lists) {
    for (const team of list) {
      // First list wins: your own copy of a team carries your record of it.
      if (sides.includes(team.id) && !found.has(team.id)) {
        found.set(team.id, team)
      }
    }
  }
  return found
}
