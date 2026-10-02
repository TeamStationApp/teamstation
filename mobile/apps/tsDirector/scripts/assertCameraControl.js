// Maestro runScript: asserts on what the phone actually reports, read back through Director's
// open control screen (dump-state `cameraControl`), not on what the iPad's picker is drawing.
//
// The screen polls the camera once a second, so every value here has made the round trip to the
// phone and back. A tap that drew the right pill but never reached the camera fails here.
//
// Env, all optional: EXPECT_ZOOM, EXPECT_POSITION, EXPECT_CODEC, EXPECT_RESPONDING.
// Unset variables are absent rather than empty in this runtime, hence the typeof guards.
function want (name) {
  switch (name) {
    case 'zoom': return typeof EXPECT_ZOOM === 'undefined' ? '' : String(EXPECT_ZOOM)
    case 'position': return typeof EXPECT_POSITION === 'undefined' ? '' : String(EXPECT_POSITION)
    case 'codec': return typeof EXPECT_CODEC === 'undefined' ? '' : String(EXPECT_CODEC)
    case 'responding': return typeof EXPECT_RESPONDING === 'undefined' ? '' : String(EXPECT_RESPONDING)
    default: return ''
  }
}

// The poll is on a one-second timer, so a value written a moment ago needs a few tries.
let control = null
let lastSeen = ''
for (let attempt = 0; attempt < 12; attempt++) {
  const reply = http.get('http://127.0.0.1:8765/dump-state')
  if (!reply.ok) throw new Error('dump-state not reachable: ' + reply.status)
  control = json(reply.body).cameraControl || {}
  if (!control.open) throw new Error('the camera control screen is not open')
  const zoom = want('zoom')
  const position = want('position')
  const codec = want('codec')
  const responding = want('responding')
  lastSeen = 'zoom=' + control.zoom + ' position=' + control.position + ' codec=' + control.codec +
    ' responding=' + control.responding + ' polls=' + control.polls + ' error=' + control.lastError
  const ok =
    (zoom === '' || String(control.zoom) === zoom) &&
    (position === '' || String(control.position) === position) &&
    (codec === '' || String(control.codec) === codec) &&
    (responding === '' || String(control.responding) === responding)
  if (ok) break
  if (attempt === 11) {
    throw new Error('camera never reported the expected state. wanted zoom=' + zoom +
      ' position=' + position + ' codec=' + codec + ' responding=' + responding + '; saw ' + lastSeen)
  }
}
