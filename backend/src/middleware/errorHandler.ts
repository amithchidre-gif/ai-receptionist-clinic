import { Request, Response, NextFunction } from 'express';

export const errorHandler = (
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  // Log error (never log stack trace in production)
  console.error(JSON.stringify({
    level: 'error',
    message: err.message,
    path: req.path,
    method: req.method,
    timestamp: new Date().toISOString(),
  }));

  // Return generic error response
  res.status(500).json({
    success: false,
    error: 'Internal server error',
  });
};
