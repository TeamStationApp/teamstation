import { Router } from 'express'

import { requireActor, requireAdmin } from '../middleware/withAuth'

/**
 * Site-administrator tools.
 *
 * `POST /admin/test-error` fails on purpose, the way an unplanned bug would:
 * it throws inside the handler, so the error travels the ordinary 500 path and
 * is reported to Sentry with the administrator's id. It is how a deployment
 * proves its crash reporting works end to end.
 */
export function adminRoutes(): Router {
  const router = Router()
  router.post('/admin/test-error', requireActor, requireAdmin, testError)
  return router
}

/** Named, so the reported stack says where it failed. */
function testError(): never {
  throw new Error('Sentry test error')
}
