// Maestro runScript: locates the two rows of a source link as they are displayed, so a flow can
// tap the chain on the picture's row and the red X on the phone's row.
//
// Rows are addressed positionally on screen, and the screen shows a linked phone directly under
// the row it controls rather than where discovery put it, so the display index is derived here
// from dump-state the same way the list derives it: stored order, linked phones pulled out and
// re-inserted after their partner.
//
// Env: VIDEO_NAME, CONTROL_NAME. Sets output.videoRow and output.controlRow (one-based display
// rows), and output.videoIndex / output.controlIndex (one-based stored rows, for the control
// channel). The phone must have an endpoint and advertise the control verbs, like findCameraRow.
const videoName = VIDEO_NAME || 'NDI HX3_A_994079'
const controlName = CONTROL_NAME || 'iPhone15'
const reply = http.get('http://127.0.0.1:8765/dump-state')
if (!reply.ok) throw new Error(`dump-state not reachable: ${reply.status}`)
const sources = json(reply.body).sources || []

const video = sources.find(source => source.name === videoName)
const control = sources.find(
  source => source.name === controlName && source.endpointHost && source.controlVersion === 'params/1'
)
if (!video || !control) {
  const seen = sources.map(source => `${source.name}[ep=${source.endpointHost || '-'}]`).join(', ')
  throw new Error(`need "${videoName}" and controllable "${controlName}" — discovery sees: ${seen}`)
}

const linkedControls = new Set(sources.filter(s => s.linkedControlIndex).map(s => s.linkedControlIndex))
const display = []
for (const source of sources) {
  if (linkedControls.has(source.index)) continue
  display.push(source.index)
  if (source.linkedControlIndex) display.push(source.linkedControlIndex)
}
output.videoRow = String(display.indexOf(video.index) + 1)
output.controlRow = String(display.indexOf(control.index) + 1)
output.videoIndex = String(video.index)
output.controlIndex = String(control.index)
