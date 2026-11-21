/**
 * Whether this is a develop phone build (`app.teamstation.develop`, the one
 * the end-to-end phones run), which carries what only tests read, such as
 * the schedule build's full log. The web has no develop build of its own.
 */
export const developBuild: boolean = false
