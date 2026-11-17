import { readFileSync, writeFileSync } from 'node:fs'

import { MODEL_PORT, SPEECH_PATH, SPEECH_PORT } from './standIns'

/**
 * Points a stack's server at the fault server's stand-ins, in its
 * `serverConfig.json`, before the server starts:
 *
 *   node -r sucrase/register e2e/faults/stackConfig.ts serverConfig.json \
 *     --places 127.0.0.1:9300
 *
 * The devops stack runs it when the ref ships it. Places goes to the Places
 * stand-in on the port devops names; Tess's model and dictation's model and
 * recogniser go to the stand-ins on their own loopback ports. The keys are
 * placeholders the stand-ins never check. Every other setting is left as it
 * was written.
 */
export function standInConfig(
  config: Record<string, unknown>,
  places: string
): Record<string, unknown> {
  const model = `http://127.0.0.1:${MODEL_PORT}/v1`
  const dictation = (config.dictation ?? {}) as Record<string, unknown>
  return {
    ...config,
    googlePlaces: { apiKey: 'stub', baseUrl: `http://${places}` },
    tess: {
      ...((config.tess ?? {}) as Record<string, unknown>),
      apiKey: 'stub',
      baseUrl: model
    },
    dictation: {
      ...dictation,
      apiKey: 'stub',
      baseUrl: model,
      sttUrl: `ws://127.0.0.1:${SPEECH_PORT}${SPEECH_PATH}`,
      anthropic: { apiKey: 'stub', baseUrl: model }
    }
  }
}

/** The config file and the Places address, from the command line. */
export function parseStackConfigArgs(argv: string[]): {
  file: string
  places: string
} {
  const at = argv.indexOf('--places')
  const places = at === -1 ? undefined : argv[at + 1]
  const file = argv.find(
    (arg, index) => !arg.startsWith('--') && index !== at + 1
  )
  if (file == null || places == null || !/^[\w.-]+:\d+$/.test(places)) {
    throw new Error(
      'usage: stackConfig.ts <serverConfig.json> --places <host:port>'
    )
  }
  return { file, places }
}

/** Rewrites `file` in place with the stand-ins' settings. */
export function rewriteConfigFile(file: string, places: string): void {
  const config = JSON.parse(readFileSync(file, 'utf8')) as Record<
    string,
    unknown
  >
  writeFileSync(
    file,
    `${JSON.stringify(standInConfig(config, places), null, 2)}\n`
  )
}

if (require.main === module) {
  const { file, places } = parseStackConfigArgs(process.argv.slice(2))
  rewriteConfigFile(file, places)
}
