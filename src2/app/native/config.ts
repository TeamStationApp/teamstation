/**
 * Where the app on a phone looks for the API.
 *
 * The web app can say `/api/v1` and mean "wherever I was served from"; an app
 * installed on a handset was served from nowhere, so it has to name the site.
 * Production by default — the same `PRIMARY_HOST` the server builds its own
 * links from — because that is what an installed app talks to, and a default
 * that only works on the machine that built it is not a default.
 *
 * Point it somewhere else for a day's work against a local server:
 *
 *     GS_API_BASE_URL=http://192.168.1.20:9100/api/v1 npm run ios
 *
 * A LAN address, not the loopback: on a simulator `127.0.0.1` is the Mac, and
 * on a handset it is the handset.
 */
import { httpOrigin, PRIMARY_HOST } from '../../common/primaryUrl'

declare const process: { env: Record<string, string | undefined> }

const configured = process.env.GS_API_BASE_URL

// A build that names the loopback cannot work on anything but the machine that
// made it — on a simulator `127.0.0.1` is the Mac, and on a handset it is the
// handset. `build.mjs` refuses the same thing for the same reason, and the
// morning that cost is written up there.
if (
  configured != null &&
  /\/\/(127\.0\.0\.1|localhost|\[::1\])/.test(configured)
) {
  throw new Error(
    `GS_API_BASE_URL=${configured} names this device's own loopback, which ` +
      'no other device can reach. Use the LAN address of the machine running ' +
      'the server.'
  )
}

export const apiBaseUrl: string =
  configured ?? `${httpOrigin(PRIMARY_HOST)}/api/v1`
