// Maestro runScript: finds the source row for a controllable Cameraman by name and enables it.
//
// Matching on the name alone is not enough on a real network. Director deliberately keeps a row
// for a camera that has gone away, so a phone that has moved address leaves a stale row with the
// same name and no endpoint; enabling that one puts a dead source on the grid and the flow then
// fails several steps later on a missing button. This picks the row that has an endpoint and
// advertises the control verbs, and enables it over the control channel rather than by tapping,
// so a list that reorders mid-discovery cannot land the tap on a different camera.
//
// Env: CAMERA_NAME (default "Phone 1"). Sets output.row to its one-based index.
const wanted = CAMERA_NAME || 'Phone 1'
const reply = http.get('http://127.0.0.1:8765/dump-state')
if (!reply.ok) throw new Error(`dump-state not reachable: ${reply.status}`)
const sources = json(reply.body).sources || []
const match = sources.find(
  source => source.name === wanted && source.endpointHost && source.controlVersion === 'params/1'
)
if (!match) {
  const seen = sources
    .map(source => `${source.name}[ep=${source.endpointHost || '-'} ctl=${source.controlVersion || '-'}]`)
    .join(', ')
  throw new Error(`no controllable source named "${wanted}" — discovery sees: ${seen}`)
}
const enabled = http.get(`http://127.0.0.1:8765/enable-source?index=${match.index}&on=true`)
if (!enabled.ok) throw new Error(`enable-source ${match.index} failed: ${enabled.status}`)
output.row = String(match.index)
