import { Request, Response } from 'express';
import { sendSuccess, sendError } from '../middleware/responseHelpers';
import * as authService from '../services/authService';

export async function register(req: Request, res: Response): Promise<void> {
  const { email, password, clinicName } = req.body as {
    email?: string;
    password?: string;
    clinicName?: string;
  };

  if (!email || !password || !clinicName) {
    sendError(res, 'email, password, and clinicName are required', 400);
    return;
  }

  try {
    const result = await authService.register(email, password, clinicName);
    sendSuccess(res, result, 201);
  } catch (error) {
    const err = error as Error;
    const knownMessages = [
      'Invalid email format',
      'Password must be at least 8 characters',
      'Clinic name is required',
      'Email already in use',
    ];
    if (knownMessages.includes(err.message)) {
      sendError(res, err.message, 400);
    } else {
      sendError(res, 'Registration failed', 500);
    }
  }
}

export async function login(req: Request, res: Response): Promise<void> {
  const { email, password } = req.body as { email?: string; password?: string };

  if (!email || !password) {
    sendError(res, 'email and password are required', 400);
    return;
  }

  try {
    const result = await authService.login(email, password);
    sendSuccess(res, result, 200);
  } catch (error) {
    const err = error as Error;
    if (err.message === 'Invalid credentials') {
      sendError(res, 'Invalid credentials', 401);
    } else {
      sendError(res, 'Login failed', 500);
    }
  }
}
