import type { Serverlet } from 'serverlet'

import type { LwsRequest } from '../types/requestTypes'

export function withLogging<T extends LwsRequest>(
  name: string,
  serverlet: Serverlet<T>
): Serverlet<T> {
  return async request => {
    const startTime = Date.now()
    const { method, path, req } = request
    const { ip, body, query } = req

    console.log(
      JSON.stringify({
        s: 'start',
        date: new Date().toISOString(),
        ip,
        method,
        path,
        reqBody: body,
        reqQuery: query
      })
    )

    try {
      const response = await serverlet(request)

      const duration = Date.now() - startTime
      let resBody
      try {
        resBody = JSON.parse(response.body as string)
      } catch (error) {
        resBody = response.body as string
      }
      console.log(
        JSON.stringify({
          s: 'finish',
          date: new Date().toISOString(),
          ip,
          method,
          path,
          status: response.status,
          resBody,
          duration
        })
      )

      return response
    } catch (error) {
      const duration = Date.now() - startTime
      console.error(
        JSON.stringify({
          s: 'error',
          date: new Date().toISOString(),
          ip,
          method,
          path,
          error: error instanceof Error ? error.message : String(error),
          duration
        })
      )

      throw error
    }
  }
}
