import { Router } from 'express'

export interface TimeBody {
  /** The server's clock, in milliseconds since the epoch. */
  now: number
}

/**
 * The server's clock, which every device that stamps a moment measures itself
 * against, so the moments from several devices line up on one clock. It needs
 * no sign-in, because a scorer offline at the field measures it as soon as it
 * can, and nothing may keep an answer: an old time is a wrong one.
 */
export function timeRoutes(): Router {
  const router = Router()
  router.get('/time', (req, res) => {
    const body: TimeBody = { now: Date.now() }
    res.set('Cache-Control', 'no-store').json(body)
  })
  return router
}
