import { build, context } from 'esbuild'

import { webSettings } from './web-build-settings.mjs'

/** The service worker's source, and the file it is served as. */
export const SERVICE_WORKER_ENTRY = 'src/app/web/sw.ts'
export const SERVICE_WORKER_FILE = 'sw.js'

/**
 * The esbuild options for the web app's service worker (`src/app/web/sw.ts`),
 * which shows the browser's notifications.
 *
 * Its name never changes: a service worker is registered by its URL, and the
 * browser checks that URL itself for a newer script, so a hashed name would
 * leave every browser on the first one it was given. It is one classic script
 * (`iife`), the kind every browser runs as a service worker. It takes the app
 * bundle's own `define`s, so it fetches the same chat crypto module with the same
 * integrity, and talks to the same API.
 */
export function serviceWorkerOptions({ out, serve, define }) {
  return {
    ...webSettings,
    entryPoints: [SERVICE_WORKER_ENTRY],
    outfile: `${out}/${SERVICE_WORKER_FILE}`,
    bundle: true,
    format: 'iife',
    target: ['es2021'],
    minify: !serve,
    // Mapped like the app bundle: a deploy uploads it, and coverage reads it.
    sourcemap: true,
    logLevel: 'info',
    define
  }
}

/** Builds the service worker once, and under `serve` keeps rebuilding it. */
export async function buildServiceWorker(settings) {
  const options = serviceWorkerOptions(settings)
  await build(options)
  if (settings.serve) {
    const watching = await context(options)
    await watching.watch()
    return watching
  }
  return undefined
}
