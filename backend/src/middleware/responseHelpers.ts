import { Response } from 'express';

export function sendSuccess(res: Response, data: unknown, statusCode = 200): void {
  res.status(statusCode).json({ success: true, data });
}

export function sendError(res: Response, message: string, statusCode = 400): void {
  res.status(statusCode).json({ success: false, error: message });
}
