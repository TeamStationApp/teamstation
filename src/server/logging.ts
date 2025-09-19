import type express from 'express'

/**
 * Log all requests.
 */
export function logging(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
): void {
  const date = new Date()
  res.on('finish', () => {
    console.log(
      date.toISOString(),
      req.ip,
      req.method,
      `${req.get('host') ?? ''}${req.path}`,
      res.statusCode,
      `${Date.now() - date.valueOf()}ms`
    )
  })
  next()
}
