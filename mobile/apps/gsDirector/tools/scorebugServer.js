#!/usr/bin/env node
// Serves a stand-in scorebug so the compositor path can be exercised without the real gamestation
// scoreboard running.
//
// Deliberately shaped like the thing it stands in for: a transparent background so the blend is
// visible over the picture, a fixed-size graphic anchored at the origin so its placement in the
// frame can be checked against the 20px inset, and a clock that ticks every second so the page
// mutates and the MutationObserver-driven snapshot path is exercised rather than just the heartbeat.

const http = require('http')
const os = require('os')

const PORT = Number(process.env.PORT || 8000)

const PAGE = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  html, body { margin: 0; padding: 0; background: transparent; }
  #bug {
    display: inline-flex; align-items: center; gap: 18px;
    font-family: -apple-system, Helvetica, sans-serif;
    background: rgba(8, 10, 14, 0.86);
    border-left: 8px solid #17d18a;
    border-radius: 10px;
    padding: 14px 22px;
  }
  .team { color: #fff; font-size: 34px; font-weight: 800; letter-spacing: 1px; }
  .score { color: #17d18a; font-size: 44px; font-weight: 900; font-variant-numeric: tabular-nums; }
  .clock { color: #ffd166; font-size: 26px; font-weight: 700; font-variant-numeric: tabular-nums;
           border-left: 2px solid rgba(255,255,255,0.18); padding-left: 18px; }
</style>
</head>
<body>
  <div id="bug">
    <span class="team">HOME</span><span class="score" id="home">3</span>
    <span class="team">AWAY</span><span class="score" id="away">1</span>
    <span class="clock" id="clock">00:00</span>
  </div>
<script>
  var started = Date.now()
  setInterval(function () {
    var elapsed = Math.floor((Date.now() - started) / 1000)
    var mm = String(Math.floor(elapsed / 60)).padStart(2, '0')
    var ss = String(elapsed % 60).padStart(2, '0')
    document.getElementById('clock').textContent = mm + ':' + ss
  }, 1000)
</script>
</body>
</html>`

function addresses () {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((entry) => entry && entry.family === 'IPv4' && !entry.internal)
    .map((entry) => entry.address)
}

http
  .createServer((request, response) => {
    console.log(`${new Date().toISOString()} ${request.socket.remoteAddress} ${request.url}`)
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store'
    })
    response.end(PAGE)
  })
  .listen(PORT, '0.0.0.0', () => {
    for (const address of addresses()) {
      console.log(`scorebug: http://${address}:${PORT}/scoreboard`)
    }
  })
