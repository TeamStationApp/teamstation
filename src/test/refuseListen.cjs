// Preloaded into a child a test wants to fail as it starts (`node -r`): its
// first HTTP listen throws, as a port it cannot have would.
const http = require('node:http')

http.Server.prototype.listen = function listen() {
  throw new Error('listen refused by the test')
}
