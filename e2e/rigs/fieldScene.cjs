const THREE_STATE = `
  const find = fiber => {
    for (let at = fiber; at != null; at = at.sibling) {
      const value = at.memoizedProps == null ? undefined : at.memoizedProps.value
      const state = value == null || value.getState == null ? undefined : value.getState()
      if (state != null && state.scene != null) return state
      const inner = find(at.child)
      if (inner != null) return inner
    }
    return undefined
  }
  let three
  for (const root of window.qaRoots || []) three = three || find(root.current)
  const project = (x, y, z) => {
    const canvas = three.gl.domElement.getBoundingClientRect()
    const v = three.camera.position.clone().set(x, y, z).project(three.camera)
    return [canvas.x + ((v.x + 1) * canvas.width) / 2, canvas.y + ((1 - v.y) * canvas.height) / 2]
  }
`

const FIELD_SCENE_PROBE = `(() => {
    window.qaRoots = []
    window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      supportsFiber: true,
      renderers: new Map(),
      inject() { return 1 },
      onCommitFiberRoot(_id, root) {
        if (!window.qaRoots.includes(root)) window.qaRoots.push(root)
      },
      onCommitFiberUnmount() {}
    }
  })()`

const BOARD_BOUNDS = `    const board = three.scene.getObjectByName('vintage-scoreboard')
    const xs = [], ys = []
    board.traverseVisible(mesh => {
      if (!mesh.geometry) return
      mesh.geometry.computeBoundingBox()
      const {min, max} = mesh.geometry.boundingBox
      for (const x of [min.x, max.x])
        for (const y of [min.y, max.y])
          for (const z of [min.z, max.z]) {
            const v = mesh.localToWorld(mesh.position.clone().set(x, y, z))
            const [px, py] = project(v.x, v.y, v.z)
            xs.push(px)
            ys.push(py)
          }
    })
    return {top: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs)}
`
module.exports = { THREE_STATE, FIELD_SCENE_PROBE, BOARD_BOUNDS }
