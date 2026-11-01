import assert from 'node:assert/strict'

/** Check rendered camera bounds and actual native focus, without removed buttons. */
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
    measured = { bounds, focused: angle?.focused, width, height }
    if (
      bounds !== undefined &&
      Math.abs(bounds.width - width) <= 2 &&
      Math.abs(bounds.height - height) <= 2 &&
      angle.focused === true
    )
      return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.fail(
    `Camera ${index} ${fullscreen ? 'fullscreen' : 'quadrant'} bounds/focus: ${JSON.stringify(measured)}`
  )
}
