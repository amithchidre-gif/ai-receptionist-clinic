// API response types
export interface User {
  id: string;
  clinicId: string;
  email: string;
  role: string;
  createdAt: string;
}

export interface Clinic {
  id: string;
  name: string;
  createdAt: string;
}

export interface Appointment {
  id: string;
  clinicId: string;
  patientId: string;
  date: string;
  status: string;
  createdAt: string;
}

export interface Patient {
  id: string;
  clinicId: string;
  name: string;
  phone: string;
  createdAt: string;
}

export interface CallLog {
  id: string;
  clinicId: string;
  patientId: string;
  callTime: string;
  duration: number;
  status: string;
  createdAt: string;
}

export interface FormResponse {
  id: string;
  clinicId: string;
  patientId: string;
  formData: Record<string, any>;
  submittedAt: string;
}

export interface DashboardStats {
  totalAppointments: number;
  totalPatients: number;
  totalCalls: number;
  totalForms: number;
}

export interface Settings {
  clinicId: string;
  phone: string;
  calendarId: string;
  aiReceptionistEnabled: boolean;
}
