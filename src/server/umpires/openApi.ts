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
  const paths: Record<string, unknown> = {
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
  for (const [path, methods, summary] of [
    [
      '/leagues/{leagueId}/umpire-levels',
      ['get', 'post'],
      'List or add league umpire levels'
    ],
    [
      '/leagues/{leagueId}/umpire-levels/{levelId}',
      ['delete'],
      'Remove a level and its requirements, certifications and assignments'
    ],
    [
      '/leagues/{leagueId}/umpire-requirements',
      ['get', 'put'],
      'Read or replace current and upcoming season umpire requirements'
    ],
    [
      '/leagues/{leagueId}/umpire-candidates',
      ['get'],
      'Find affiliated people who do not hold the umpire role'
    ],
    [
      '/leagues/{leagueId}/umpires',
      ['get', 'post'],
      'List or grant independent league umpire roles'
    ],
    [
      '/leagues/{leagueId}/umpires/{userId}',
      ['delete'],
      'Revoke a role and non-final assignments, preserving certifications'
    ],
    [
      '/leagues/{leagueId}/umpires/{userId}/certifications',
      ['put'],
      'Set a level plate and field certification'
    ]
  ] as const) {
    const parameters: unknown[] = [...path.matchAll(/\{(\w+)\}/g)].map(m => ({
      name: m[1],
      in: 'path',
      required: true,
      schema: { type: 'string' }
    }))
    if (path.endsWith('umpire-candidates'))
      parameters.push({
        name: 'q',
        in: 'query',
        description:
          'Case-insensitive name substring; empty returns no people.',
        schema: { type: 'string', default: '' }
      })
    paths[path] = Object.fromEntries(
      methods.map(method => [
        method,
        {
          summary,
          security: [{ bearer: [] }],
          parameters,
          responses: {
            ...responses,
            200: { description: 'Requested umpire resource' }
          },
          ...(method === 'post' || method === 'put'
            ? {
                requestBody: {
                  required: true,
                  content: {
                    'application/json': { schema: { type: 'object' } }
                  }
                }
              }
            : {})
        }
      ])
    )
  }

  paths['/me/umpire-leagues'] = {
    get: {
      summary: 'Managed leagues where the caller holds an explicit umpire role',
      security: [{ bearer: [] }],
      responses: {
        ...responses,
        200: { description: 'Accessible umpire leagues' }
      }
    }
  }
  paths['/leagues/{leagueId}/umpire-schedule'] = {
    get: {
      summary: 'Umpire schedule with availability and conflicts',
      security: [{ bearer: [] }],
      parameters: [
        ...parameters,
        {
          name: 'view',
          in: 'query',
          schema: {
            type: 'string',
            enum: ['umpire', 'league'],
            default: 'umpire'
          },
          description: 'Umpire involvement window or administrator league view'
        },
        ...['levels', 'days', 'from', 'to'].map(name => ({
          name,
          in: 'query',
          ...(name === 'days' || name === 'levels'
            ? {
                style: 'form',
                explode: true,
                schema: { type: 'array', items: { type: 'string' } }
              }
            : { schema: { type: 'string', default: '' } }),
          description:
            name === 'days'
              ? 'Repeated weekdays, Monday 0 to Sunday 6; empty means all'
              : name === 'levels'
                ? 'Repeated level IDs needing an umpire; empty means all'
                : 'Game-local HH:mm; filtering requires both endpoints, with to after from'
        }))
      ],
      responses: {
        ...responses,
        200: { description: 'Visible games, slot choices and credit teams' }
      }
    }
  }
  return paths
}
