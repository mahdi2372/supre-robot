import type { NextFunction, Request, RequestHandler, Response } from 'express';

type AsyncRoute = (req: Request, res: Response, next: NextFunction) => Promise<unknown>;

/**
 * Express 4 does not forward rejected promises from async route handlers to
 * the error middleware. Wrap every async route with this so failures reach
 * createApiErrorHandler and clients get a proper status instead of a hung
 * request + unhandled rejection.
 */
export function ah(fn: AsyncRoute): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}
