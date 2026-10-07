import { asArray, asBoolean, asObject, asOptional, asString } from 'cleaners'

declare const process: { env: Record<string, string | undefined> }

export function asHttpsUrl(value: unknown): string {
  const text = asString(value)
  const url = new URL(text)
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '')
    throw new TypeError('Expected an HTTPS URL without credentials')
  return text
}

export const asBuildsLink = asObject({ url: asOptional(asHttpsUrl) })
export const asApproval = asObject({
  clientName: asString,
  scopes: asArray(asString),
  decision: asOptional(asString),
  resumeUrl: asOptional(asHttpsUrl),
  csrfToken: asOptional(asString),
  signedIn: asOptional(asBoolean)
})
export type Approval = ReturnType<typeof asApproval>

export const asBuildInfo = asObject({
  app: asString,
  version: asString,
  buildNumber: asString,
  branch: asString,
  commit: asString,
  builtAt: asString
})
export type BuildInfo = ReturnType<typeof asBuildInfo>

export function readBuildInfo(text: string | undefined): BuildInfo {
  if (text != null && text !== '') return asBuildInfo(JSON.parse(text))
  return {
    app: 'TeamStation',
    version: 'development',
    buildNumber: '—',
    branch: '—',
    commit: '—',
    builtAt: '—'
  }
}

// Bundlers replace this single public metadata value. No deploy config or
// signing material is imported into an application bundle.
export const buildInfo = readBuildInfo(process.env.TS_BUILD_INFO)
