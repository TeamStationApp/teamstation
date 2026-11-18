import { asPreparedPreview } from '../common/schedulePreviews'
import { buildSchedule, engineResult } from '../common/scheduler/engine'

/**
 * Integration fixtures emulate the device computation between the two HTTP
 * calls with the C++ engine's Node addon, which builds on a libuv worker, so
 * the server in the same process keeps serving (and closing idle
 * connections) while it runs.
 */
export async function deviceSchedulerResponse(
  request: (method: string, path: string, body?: unknown) => Promise<Response>,
  method: string,
  path: string,
  body?: unknown
): Promise<Response> {
  const response = await request(method, path, body)
  if (
    !response.ok ||
    method !== 'POST' ||
    !/^\/leagues\/[^/]+\/schedule-previews\/preparations$/.test(path)
  )
    return response
  const prepared = asPreparedPreview(await response.json())
  const completed = await request(
    'PUT',
    `/schedule-previews/${prepared.id}/result`,
    engineResult(await buildSchedule({ input: prepared.input }))
  )
  return new Response(await completed.text(), {
    status: completed.ok ? 201 : completed.status,
    headers: { 'Content-Type': 'application/json' }
  })
}
