/**
 * Prints a session token for the player-layouts fixture's administrator, and
 * nothing else, for `lineScoreProbe.sh`.
 */
import { signedIn } from '../../../src/app/player/playerLayoutsRig.e2e'

signedIn()
  .then(token => {
    process.stdout.write(token)
    process.exit(0)
  })
  .catch((error: unknown) => {
    console.error(error)
    process.exit(1)
  })
