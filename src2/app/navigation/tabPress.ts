/**
 * What a press on one of the three destinations does to the stacks.
 *
 * Each tab keeps its own stack, so moving between tabs keeps where you were in
 * each: a team opened from Home is still open when you come back from Videos.
 * That leaves pressing the tab you are already on, which used to do nothing at
 * all — and so the three icons were the one way of moving around the app that
 * could not take you anywhere. Now it is a step back out: press Home from a
 * game inside a team inside Home and you walk out to Home, one press per step,
 * the way a tab bar behaves everywhere else.
 *
 * At the root there is nothing to walk out of, and the record comes back
 * unchanged — the same object, so the state does not move and nothing
 * re-renders to redraw the screen already on show.
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
  return { ...stacks, [pressed]: held.slice(0, -1) }
}
