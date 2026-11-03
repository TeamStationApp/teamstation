import assert from 'node:assert/strict'

/** Check rendered camera bounds without removed buttons or unsupported focus fields. */
export async function assertCameraLayout(
  tv: { hierarchy: () => Promise<any> },
  index: number,
  fullscreen: boolean
): Promise<void> {
  let measured: unknown
  for (let attempt = 0; attempt < 50; attempt++) {
    const tree = await tv.hierarchy()
    const find = (node: any): any =>
      node.id === `tv-angle-${index}`
        ? node
        : node.children?.map(find).find(Boolean)
    const angle = find(tree)
    const bounds = angle?.bounds
    const width = tree.bounds.width / (fullscreen ? 1 : 2)
    const height = tree.bounds.height / (fullscreen ? 1 : 2)
    measured = { bounds, width, height }
    if (
      bounds !== undefined &&
      Math.abs(bounds.width - width) <= 2 &&
      Math.abs(bounds.height - height) <= 2
    )
      return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.fail(
    `Camera ${index} ${fullscreen ? 'fullscreen' : 'quadrant'} bounds: ${JSON.stringify(measured)}`
  )
}

/** Open stats through the bottom focus boundary without changing playback time. */
export async function openStatsPanel(tv: {
  assertNotVisible: (options: {
    id: string
    timeout: number
  }) => Promise<unknown>
  assertVisible: (options: { id: string; timeout: number }) => Promise<unknown>
  hierarchy: () => Promise<any>
  swipe: (options: { direction: 'DOWN' }) => Promise<unknown>
  waitForAnimationToEnd: (options: { timeout: number }) => Promise<unknown>
}): Promise<void> {
  await tv.assertNotVisible({ id: 'tv-scrubber', timeout: 5000 })
  const hasPanel = (node: any): boolean =>
    node.id === 'tv-box-panel' || node.children?.some(hasPanel) === true
  // The first swipe may move from the upper camera to the lower one. The
  // next crosses the bottom edge. Stop once open so we do not scroll it.
  for (let attempt = 0; attempt < 2; attempt++) {
    await tv.swipe({ direction: 'DOWN' })
    await tv.waitForAnimationToEnd({ timeout: 1000 })
    if (hasPanel(await tv.hierarchy())) break
  }
  await tv.assertVisible({ id: 'tv-box-panel', timeout: 5000 })
}
