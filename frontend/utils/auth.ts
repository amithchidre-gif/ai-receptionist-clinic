// Auth utility for localStorage (SSR safe)
export function saveToken(token: string) {
  if (typeof window !== 'undefined') {
    localStorage.setItem('token', token);
  }
}

export function getToken(): string | null {
  if (typeof window !== 'undefined') {
    return localStorage.getItem('token');
  }
  return null;
}

export function removeToken() {
  if (typeof window !== 'undefined') {
    localStorage.removeItem('token');
  }
}

export function saveClinicId(id: string) {
  if (typeof window !== 'undefined') {
    localStorage.setItem('clinicId', id);
  }
}

export function getClinicId(): string | null {
  if (typeof window !== 'undefined') {
    return localStorage.getItem('clinicId');
  }
  return null;
}

export function removeClinicId() {
  if (typeof window !== 'undefined') {
    localStorage.removeItem('clinicId');
  }
}

export function isLoggedIn(): boolean {
  if (typeof window !== 'undefined') {
    return !!localStorage.getItem('token');
  }
  return false;
}
