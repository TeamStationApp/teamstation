import { asObject, asOptional, asString, asUnknown } from 'cleaners'
import { Router } from 'express'
import {
  execute,
  type GraphQLError,
  type GraphQLFormattedError,
  Kind,
  OperationTypeNode,
  parse,
  specifiedRules,
  validate
} from 'graphql'
import type { Kysely } from 'kysely'

import type { Database } from '../db/database'
import { readerHeaders, RestError, restReader } from '../graphql/restReader'
import {
  depthLimit,
  graphqlSchema,
  MAX_FIELDS,
  sizeLimit
} from '../graphql/schema'
import { statsLimit } from '../graphql/statsField'
import { cleanBody } from '../jsonBody'
import { skipAudit } from '../middleware/withAudit'
import { requireActor } from '../middleware/withAuth'
import { withAsync } from '../middleware/withErrors'

export interface GraphqlRouteOptions {
  /** This server's own address, where each field's REST route is read. */
  origin: () => string
  /** For `Query.stats`, which reads its splits straight from the database. */
  db: Kysely<Database>
  fetch?: typeof fetch
  /** How long a whole query may take; 25 s, inside Tess's loopback's 30. */
  deadlineMs?: number
}

/** How long a whole query may take, unless the options say otherwise. */
export const QUERY_DEADLINE_MS = 25000

/** The longest query text taken. */
export const MAX_QUERY_LENGTH = 20000

const asGraphqlBody = asObject({
  query: asString,
  variables: asOptional(asObject(asUnknown)),
  operationName: asOptional(asString)
})

/** An error as the response carries it, with the REST status behind it. */
function formatted(error: GraphQLError): GraphQLFormattedError {
  const shown = error.toJSON()
  const cause = error.originalError
  if (cause instanceof RestError)
    return {
      ...shown,
      extensions: { ...shown.extensions, status: cause.status }
    }
  // Anything else that failed is the server's, and says nothing of it to
  // the caller; the log keeps what it was, so a route that changed shape
  // under the schema can be found.
  if (cause != null) {
    console.error(`graphql: ${(error.path ?? []).join('.')}: ${String(cause)}`)
    return { ...shown, message: 'This field could not be read' }
  }
  return shown
}

/**
 * `POST /graphql`: a read-only GraphQL query, run as the caller. Each field
 * is read from the REST route that serves it, with the caller's own
 * credentials (`RestReader`), so the answer holds nothing that route would
 * not give them. The schema has no mutation, so a query cannot write; and
 * since it writes nothing, it is left out of the audit trail.
 */
export function graphqlRoutes(options: GraphqlRouteOptions): Router {
  const router = Router()
  router.post(
    '/graphql',
    requireActor,
    withAsync(async (req, res) => {
      skipAudit(res.locals)
      const body = cleanBody(asGraphqlBody, req.body)
      const refuse = (message: string): void => {
        res.status(400).json({ errors: [{ message }] })
      }
      if (body.query.length > MAX_QUERY_LENGTH) {
        refuse(`A query may be at most ${MAX_QUERY_LENGTH} characters`)
        return
      }
      let document
      try {
        document = parse(body.query)
      } catch (error) {
        res.status(400).json({ errors: [formatted(error as GraphQLError)] })
        return
      }
      const problems = validate(graphqlSchema, document, [
        ...specifiedRules,
        depthLimit,
        sizeLimit,
        statsLimit
      ])
      if (problems.length > 0) {
        res.status(400).json({ errors: problems.map(formatted) })
        return
      }
      const writes = document.definitions.some(
        definition =>
          definition.kind === Kind.OPERATION_DEFINITION &&
          definition.operation !== OperationTypeNode.QUERY
      )
      if (writes) {
        refuse('This API only reads: ask with a query')
        return
      }
      // One deadline for the whole query, inside Tess's own, and an end to
      // its reads when the caller hangs up.
      const query = new AbortController()
      const deadline = setTimeout(() => {
        query.abort()
      }, options.deadlineMs ?? QUERY_DEADLINE_MS)
      res.on('close', () => {
        if (!res.writableFinished) query.abort()
      })
      const budget = { used: 0 }
      let result
      try {
        result = await execute({
          schema: graphqlSchema,
          document,
          variableValues: body.variables,
          operationName: body.operationName,
          contextValue: {
            reader: restReader(options.origin(), readerHeaders(req), {
              fetch: options.fetch,
              signal: query.signal
            }),
            budget,
            signal: query.signal,
            db: options.db,
            actor: req.actor
          }
        })
      } finally {
        clearTimeout(deadline)
      }
      if (budget.used > MAX_FIELDS) {
        refuse(
          `This query asks for more than ${MAX_FIELDS} fields. Ask for less`
        )
        return
      }
      const errors = result.errors?.map(formatted)
      // A query that ran answers 200, its refused fields among its errors;
      // only one that could not start (its variables) is the request's fault.
      res.status('data' in result ? 200 : 400).json({
        ...(errors == null ? {} : { errors }),
        data: result.data ?? null
      })
    })
  )
  return router
}
