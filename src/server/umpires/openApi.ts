export function umpirePaths(errorResponse: unknown): Record<string, unknown> {
  const settings = {
    type: 'object',
    properties: {
      management: { type: 'boolean' },
      credits: { type: 'boolean' }
    }
  }
  const parameters = [
    { name: 'leagueId', in: 'path', required: true, schema: { type: 'string' } }
  ]
  const responses = {
    200: {
      description: 'League umpire settings',
      content: { 'application/json': { schema: settings } }
    },
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    404: errorResponse
  }
  return {
    '/leagues/{leagueId}/umpire-settings': {
      get: {
        summary: 'Read league umpire settings as an administrator',
        security: [{ bearer: [] }],
        parameters,
        responses
      },
      put: {
        summary: 'Update umpire settings, preserving roles and assignments',
        security: [{ bearer: [] }],
        parameters,
        requestBody: {
          required: true,
          content: { 'application/json': { schema: settings } }
        },
        responses
      }
    }
  }
}
