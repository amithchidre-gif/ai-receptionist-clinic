import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { config } from '../config/env';
import { findUserByEmail, createUser } from '../models/userModel';
import { createClinic, createClinicSettings } from '../models/clinicModel';

const SALT_ROUNDS = 12;

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export interface RegisterResult {
  token: string;
  clinicId: string;
}

export interface LoginResult {
  token: string;
  clinicId: string;
  email: string;
}

export async function register(
  email: string,
  password: string,
  clinicName: string
): Promise<RegisterResult> {
  if (!isValidEmail(email)) {
    throw new Error('Invalid email format');
  }
  if (password.length < 8) {
    throw new Error('Password must be at least 8 characters');
  }
  if (!clinicName.trim()) {
    throw new Error('Clinic name is required');
  }

  const existing = await findUserByEmail(email);
  if (existing) {
    throw new Error('Email already in use');
  }

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

  const clinic = await createClinic(clinicName.trim());
  const user = await createUser(email, passwordHash, clinic.id, 'admin');
  await createClinicSettings(clinic.id);

  const token = jwt.sign(
    { userId: user.id, clinicId: clinic.id, role: 'admin' },
    config.jwtSecret,
    { expiresIn: '7d' }
  );

  console.log(JSON.stringify({
    level: 'info',
    service: 'authService',
    message: 'Clinic registered',
    clinicId: clinic.id,
    timestamp: new Date().toISOString(),
  }));

  return { token, clinicId: clinic.id };
}

export async function login(email: string, password: string): Promise<LoginResult> {
  const user = await findUserByEmail(email);
  if (!user) {
    throw new Error('Invalid credentials');
  }

  const passwordMatch = await bcrypt.compare(password, user.passwordHash);
  if (!passwordMatch) {
    throw new Error('Invalid credentials');
  }

  const token = jwt.sign(
    { userId: user.id, clinicId: user.clinicId, role: user.role },
    config.jwtSecret,
    { expiresIn: '7d' }
  );

  console.log(JSON.stringify({
    level: 'info',
    service: 'authService',
    message: 'User logged in',
    clinicId: user.clinicId,
    timestamp: new Date().toISOString(),
  }));

  return { token, clinicId: user.clinicId, email: user.email };
}
