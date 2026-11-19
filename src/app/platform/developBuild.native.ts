import { appOrigin } from '../native/config'
import { isDevelopBuild } from '../native/serverOverride'

/**
 * Whether this is a develop phone build (`app.teamstation.develop`, the one
 * the end-to-end phones run), by the app origin it was built with, which
 * carries what only tests read, such as the schedule build's full log. A
 * stable build never does.
 */
export const developBuild: boolean = isDevelopBuild(appOrigin)
