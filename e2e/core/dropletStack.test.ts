import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  dropletStackHandle,
  faultControl,
  requireDropletHandle
} from './dropletStack'
import { HarnessError } from './result'

const HANDLE = {
  version: 2,
  id: 'e2e-stack-20261116-120000',
  name: 'e2e-04',
  origin: 'https://e2e-04.example.test',
  api: 'https://e2e-04.example.test/api/v1',
  ssh: 'observer@203.0.113.4',
  serverLog: '/srv/e2e/log/api.log',
  hlsRoot: '/srv/e2e/media/work/videos',
  databaseUrl:
    'postgres://u:p@e2e-04.example.test:5432/teamstation?sslmode=require',
  faults: { url: 'https://e2e-04.example.test/__e2e', token: 'tok' }
}

/** A fault server that answers `status`, recording each call. */
function faultServer(status = 200): {
  fetchFn: typeof fetch
  calls: Array<{ url: string; method: string; auth: string; body?: string }>
} {
  const calls: Array<{
    url: string
    method: string
    auth: string
    body?: string
  }> = []
  const fetchFn = (async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>
    calls.push({
      url,
      method: init.method ?? 'GET',
      auth: headers.authorization,
      ...(typeof init.body === 'string' ? { body: init.body } : {})
    })
    const body = url.includes('/errors')
      ? {
          errors: [{ at: 5, method: 'GET', path: '/api/v1/teams', status: 500 }]
        }
      : { fault: null }
    return new Response(JSON.stringify(body), { status })
  }) as typeof fetch
  return { fetchFn, calls }
}

describe('a droplet stack', function () {
  it('sets its fault and reads its 5xx through the fault server, with the token', async function () {
    const { fetchFn, calls } = faultServer()
    const control = faultControl(HANDLE.faults, fetchFn)
    await control.setFault('api-500')
    expect(await control.serverErrors(3)).deep.equals([
      { at: 5, method: 'GET', path: '/api/v1/teams', status: 500 }
    ])
    expect(calls).deep.equals([
      {
        url: 'https://e2e-04.example.test/__e2e/fault',
        method: 'PUT',
        auth: 'Bearer tok',
        body: '{"fault":"api-500"}'
      },
      {
        url: 'https://e2e-04.example.test/__e2e/errors?since=3',
        method: 'GET',
        auth: 'Bearer tok'
      }
    ])
  })

  it('calls a refusal from the fault server a harness error', async function () {
    const control = faultControl(HANDLE.faults, faultServer(401).fetchFn)
    let failure: unknown
    await control.setFault(null).catch((error: unknown) => {
      failure = error
    })
    expect(failure).instanceOf(HarnessError)
    expect(String(failure)).includes('PUT fault with 401')
  })

  it('gives a scenario the fault control and server errors a handle names', async function () {
    const { fetchFn } = faultServer()
    const stack = dropletStackHandle(
      {
        id: HANDLE.id,
        origin: HANDLE.origin,
        handle: HANDLE,
        baselineManifest: '/stacks/x.baseline'
      },
      { fetchFn }
    )
    expect(stack.baselineManifest).equals('/stacks/x.baseline')
    expect(await stack.serverErrors(0)).length(1)
    await stack.setFault?.(null)
    expect(() =>
      dropletStackHandle({ id: 'x', origin: 'https://x.test' })
    ).to.throw('has no handle')
    expect(requireDropletHandle(HANDLE).name).equals('e2e-04')
  })
})
