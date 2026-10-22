/**
 * What a press on one of the navbar destinations does to the stacks.
 *
 * Each tab keeps its own stack, so moving between tabs keeps where you were in
 * each: a team opened from Home is still open when you come back from Videos.
 * Pressing the tab you are already on clears that stack to its root in one
 * press. Home, then a team, a game and a player, then Home again, is the home
 * screen.
 *
 * At the root there is nothing to clear, and the record comes back unchanged —
 * the same object, so the state does not move and nothing re-renders to redraw
 * the screen already on show.
 */
export function stacksAfterTabPress<Tab extends string, Step>(
  stacks: Record<Tab, Step[]>,
  // `NoInfer`, or the tabs are read off whichever two were passed rather than
  // off the record, and the answer is typed as holding only those.
  current: NoInfer<Tab>,
  pressed: NoInfer<Tab>
): Record<Tab, Step[]> {
  if (pressed !== current) return stacks
  const held = stacks[pressed]
  if (held.length === 0) return stacks
  return { ...stacks, [pressed]: [] }
}
