import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config/env';

export interface AuthUser {
  userId: string;
  clinicId: string;
  role: string;
}

// Extend Express Request to include the authenticated user
declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export function verifyToken(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ success: false, error: 'Authentication required' });
    return;
  }

  const token = authHeader.slice(7); // strip "Bearer "

  try {
    const payload = jwt.verify(token, config.jwtSecret) as AuthUser;
    req.user = {
      userId: payload.userId,
      clinicId: payload.clinicId,
      role: payload.role,
    };
    next();
  } catch {
    res.status(401).json({ success: false, error: 'Authentication required' });
  }
}
