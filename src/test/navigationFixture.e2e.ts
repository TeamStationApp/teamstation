import { readFile, writeFile } from 'node:fs/promises'

export interface NavigationFixture {
  origin: string
  token: string
  world?: string
}

/** Scope both cookies to this fixture's host. The world routes concurrent remote fixtures. */
export function navigationCookies(
  data: NavigationFixture,
  sessionName: string
): Array<{
  name: string
  value: string
  domain: string
  path: string
  httpOnly: boolean
}> {
  const options = {
    domain: new URL(data.origin).hostname,
    path: '/',
    httpOnly: true
  }
  return [
    { ...options, name: sessionName, value: data.token },
    ...(data.world == null
      ? []
      : [{ ...options, name: 'ts_navigation_fixture', value: data.world }])
  ]
}

export interface OwnedNavigationFixture<T> {
  data: T
  close: () => Promise<void>
}

/** Seed on the fixture host, or drive its private manifest from the browser host. */
export async function navigationFixture<T extends NavigationFixture>(
  name: string,
  seed: () => Promise<OwnedNavigationFixture<T>>,
  drive: (data: T) => Promise<void>
): Promise<void> {
  const input = process.env.TS_NAV_FIXTURE_FILE
  const output = process.env.TS_NAV_FIXTURE_OUTPUT
  if (input != null && output != null)
    throw new Error('Choose either a navigation fixture input or output')
  if (input != null) {
    const manifest = JSON.parse(await readFile(input, 'utf8'))
    if (
      manifest.name !== name ||
      new URL(manifest.data.origin).protocol !== 'https:'
    )
      throw new Error('Expected a matching HTTPS navigation fixture')
    await drive(manifest.data)
    return
  }
  const fixture = await seed()
  try {
    if (output == null) {
      await drive(fixture.data)
      return
    }
    const origin = process.env.TS_NAV_FIXTURE_ORIGIN
    if (origin == null || new URL(origin).protocol !== 'https:')
      throw new Error(
        'Supply TS_NAV_FIXTURE_ORIGIN with the fixture HTTPS origin'
      )
    // The coordinator configures HTTPS forwarding from the public origin to
    // this loopback server, then privately transfers the manifest to the driver.
    await writeFile(
      output,
      JSON.stringify({
        name,
        upstream: fixture.data.origin,
        data: { ...fixture.data, origin, world: name }
      }),
      { mode: 0o600, flag: 'wx' }
    )
    await new Promise<void>(resolve => {
      process.once('SIGTERM', resolve)
      process.once('SIGINT', resolve)
    })
  } finally {
    await fixture.close()
  }
}
