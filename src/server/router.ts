import express from 'express'

// import makeRouter from 'express-promise-router'
import { commandGetPromo } from './routes/promoRoutes'

const router = express.Router()

// Promo queries:
router.get('/api/v1/promo', commandGetPromo)

/**
 * Picks between the express router and the new subdomain router.
 */
export function topRouter(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
): void {
  // Use the Express router for the API and manifest routes:
  if (req.path.startsWith('/api/')) {
    router(req, res, next)
    return
  }
  res.status(404).send('Invalid path')
}
