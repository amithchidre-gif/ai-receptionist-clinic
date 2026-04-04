import React, { useEffect, useState } from 'react';
import { get } from '../services/apiClient';
import LoadingSpinner from '../components/LoadingSpinner';
import ErrorMessage from '../components/ErrorMessage';
import EmptyState from '../components/EmptyState';
import { formatDate } from '../utils/format';

interface FormResponse {
  id: string;
  appointmentId: string;
  patientName: string;
  appointmentDate: string;
  submittedAt: string;
}

const FormsPage: React.FC = () => {
  const [forms, setForms] = useState<FormResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchForms();
  }, []);

  const fetchForms = () => {
    setLoading(true);
    get('/api/forms')
      .then((res) => {
        // Map the response - use appointment_id for PDF download
        const mappedForms = res.map((form: any) => ({
          id: form.id,
          appointmentId: form.appointment_id,  // Use appointment_id for PDF endpoint
          patientName: form.patient_name,
          appointmentDate: form.appointment_date,
          submittedAt: form.submitted_at,
        }));
        setForms(mappedForms);
        setError(null);
      })
      .catch((err) => setError(err.message || 'Failed to load forms'))
      .finally(() => setLoading(false));
  };

  const downloadPDF = async (appointmentId: string) => {
    try {
      const token = localStorage.getItem('token');
      if (!token) {
        console.error('No auth token found');
        alert('Please login again');
        return;
      }

      console.log('Downloading PDF for appointment:', appointmentId);
      
      const response = await fetch(`/api/forms/${appointmentId}/pdf`, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      console.log('Response status:', response.status);
      
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || 'Failed to download PDF');
      }

      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `intake-form-${appointmentId}.pdf`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (err: any) {
      console.error('PDF download failed:', err);
      alert(err.message || 'Failed to download PDF. Please try again.');
    }
  };

  if (loading) return <LoadingSpinner />;
  if (error) return <ErrorMessage message={error} />;
  if (!forms.length) return <EmptyState message="No forms yet — they appear after patients complete their intake" />;

  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold mb-6">Forms</h1>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b">
              <th className="py-2 px-4 text-left">Patient Name</th>
              <th className="py-2 px-4 text-left">Appointment Date</th>
              <th className="py-2 px-4 text-left">Submitted At</th>
              <th className="py-2 px-4 text-left">Actions</th>
              </tr>
          </thead>
          <tbody>
            {forms.map((form) => (
              <tr key={form.id} className="border-b last:border-0">
                <td className="py-2 px-4">{form.patientName || '—'}</td>
                <td className="py-2 px-4">{form.appointmentDate ? formatDate(form.appointmentDate) : '—'}</td>
                <td className="py-2 px-4">{form.submittedAt ? new Date(form.submittedAt).toLocaleString() : '—'}</td>
                <td className="py-2 px-4">
                  <button
                    onClick={() => downloadPDF(form.appointmentId)}
                    className="bg-blue-500 hover:bg-blue-600 text-white px-3 py-1 rounded text-sm"
                  >
                    View PDF
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default FormsPage;
