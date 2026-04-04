import React, { useEffect, useState } from 'react';
import { Appointment, Patient } from '../types';
import { get, patch } from '../services/apiClient';
import LoadingSpinner from '../components/LoadingSpinner';
import ErrorMessage from '../components/ErrorMessage';
import EmptyState from '../components/EmptyState';
import Toast from '../components/Toast';
import { formatDate, formatTime } from '../utils/format';

const statusColors: Record<string, string> = {
  scheduled: 'bg-blue-100 text-blue-700',
  cancelled: 'bg-red-100 text-red-700',
  completed: 'bg-green-100 text-green-700',
};

interface AppointmentRow extends Appointment {
  patientName: string;
  formComplete: boolean;
}

const AppointmentsPage: React.FC = () => {
  const [appointments, setAppointments] = useState<AppointmentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

  useEffect(() => {
    fetchAppointments();
  }, []);

  const fetchAppointments = () => {
    setLoading(true);
    get('/api/appointments')
      .then((res) => {
        setAppointments(res);
        setError(null);
      })
      .catch((err) => setError(err.message || 'Failed to load appointments'))
      .finally(() => setLoading(false));
  };

  const handleCancel = async (id: string) => {
    try {
      await patch(`/api/appointments/${id}/cancel`);
      setAppointments((prev) => prev.map((a) => a.id === id ? { ...a, status: 'cancelled' } : a));
      setToast({ message: 'Appointment cancelled', type: 'success' });
    } catch (e: any) {
      setToast({ message: e.message || 'Failed to cancel', type: 'error' });
    }
  };

  if (loading) return <LoadingSpinner />;
  if (error) return <ErrorMessage message={error} />;
  if (!appointments.length) return <EmptyState message="No appointments yet — they will appear after the first booking" />;

  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold mb-6">Appointments</h1>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b">
              <th className="py-2 px-4 text-left">Patient Name</th>
              <th className="py-2 px-4 text-left">Date</th>
              <th className="py-2 px-4 text-left">Time</th>
              <th className="py-2 px-4 text-left">Status</th>
              <th className="py-2 px-4 text-left">Form Complete</th>
              <th className="py-2 px-4 text-left">Actions</th>
            </tr>
          </thead>
          <tbody>
            {appointments.map((appt) => (
              <tr key={appt.id} className="border-b last:border-0">
                <td className="py-2 px-4">{appt.patientName}</td>
                <td className="py-2 px-4">{formatDate(appt.appointmentDate)}</td>
                <td className="py-2 px-4">{formatTime(appt.appointmentTime)}</td>
                <td className="py-2 px-4">
                  <span className={`px-2 py-1 rounded-full text-xs ${statusColors[appt.status]}`}>
                    {appt.status}
                  </span>
                </td>
                <td className="py-2 px-4">
                  {appt.formCompleted ? '✓' : '—'}
                </td>
                <td className="py-2 px-4">
                  {appt.status === 'scheduled' && (
                    <button
                      onClick={() => handleCancel(appt.id)}
                      className="text-red-600 hover:text-red-800 text-sm"
                    >
                      Cancel
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {toast && (
        <Toast
          message={toast.message}
          type={toast.type}
          onClose={() => setToast(null)}
        />
      )}
    </div>
  );
};

export default AppointmentsPage;
