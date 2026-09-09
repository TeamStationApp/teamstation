// Maestro runScript: waits for a tile to be live, read from dump-state rather than from the debug
// HUD.
//
// The HUD carries `source=N state=live`, which is convenient to assert on and costs the flow the
// HUD itself — it is drawn across the top of the grid, over the tile chrome (the camera pills and
// the three-dot button) that a control flow needs to tap. Reading the same fact from the telemetry
// snapshot leaves the grid unobscured.
//
// Env: SOURCE (one-based tile, default 1), TIMEOUT_MS (default 60000).
const source = Number(typeof SOURCE === 'undefined' ? 1 : SOURCE)
const timeout = Number(typeof TIMEOUT_MS === 'undefined' ? 60000 : TIMEOUT_MS)
const deadline = Date.now() + timeout
let seen = 'nothing'
while (Date.now() < deadline) {
  const reply = http.get('http://127.0.0.1:8765/dump-state')
  if (!reply.ok) throw new Error(`dump-state not reachable: ${reply.status}`)
  const tiles = json(reply.body).tiles || []
  const tile = tiles.find(candidate => candidate.index === source - 1)
  if (tile) {
    seen = `state=${tile.state} src=${tile.displayName || '-'} f=${tile.frameID || 0}`
    if (tile.state === 'live' && (tile.frameID || 0) > 0) {
      output.frames = String(tile.frameID)
      output.rate = String(tile.framesPerSecond || 0)
      return
    }
  }
}
throw new Error(`source ${source} never went live within ${timeout}ms — saw ${seen}`)
