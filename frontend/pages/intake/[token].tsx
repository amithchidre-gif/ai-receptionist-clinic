import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import axios from 'axios';
import ErrorMessage from '../../components/ErrorMessage';
import LoadingSpinner from '../../components/LoadingSpinner';

interface PrefillData {
  clinicName: string;
  fullName: string;
  dob: string;
  phone: string;
  [key: string]: any;
}

const IntakeFormPage: React.FC = () => {
  const router = useRouter();
  const { token } = router.query;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [prefill, setPrefill] = useState<PrefillData | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState({
    fullName: '',
    dob: '',
    phone: '',
    reason: '',
    medications: '',
    allergies: '',
    insuranceProvider: '',
    insuranceMemberId: '',
    emergencyContactName: '',
    emergencyContactPhone: '',
  });

  useEffect(() => {
    if (!token) return;
    setLoading(true);
    setError('');
    axios.get(`/form/${token}`)
      .then(res => {
        setPrefill(res.data);
        setForm(f => ({
          ...f,
          fullName: res.data.fullName || '',
          dob: res.data.dob || '',
          phone: res.data.phone || '',
        }));
        setLoading(false);
      })
      .catch(err => {
        if (err.response && err.response.status === 410) {
          setError('This link has expired or is invalid. Please contact the clinic.');
        } else {
          setError('This link has expired or is invalid. Please contact the clinic.');
        }
        setLoading(false);
      });
  }, [token]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target;
    setForm(f => ({ ...f, [name]: value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      await axios.post('/api/forms/submit', {
        token,
        responses: {
          fullName: form.fullName,
          dob: form.dob,
          phone: form.phone,
          reason: form.reason,
          medications: form.medications,
          allergies: form.allergies,
          insuranceProvider: form.insuranceProvider,
          insuranceMemberId: form.insuranceMemberId,
          emergencyContactName: form.emergencyContactName,
          emergencyContactPhone: form.emergencyContactPhone,
        },
      });
      setSubmitted(true);
    } catch (err) {
      setError('Submission failed. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  // Set page title
  useEffect(() => {
    if (prefill?.clinicName) {
      document.title = `Patient Intake Form — ${prefill.clinicName}`;
    } else {
      document.title = 'Patient Intake Form';
    }
  }, [prefill]);

  if (loading) return <div className="flex items-center justify-center min-h-screen bg-white"><LoadingSpinner /></div>;
  if (error) return <div className="flex items-center justify-center min-h-screen bg-white"><ErrorMessage message={error} /></div>;
  if (submitted) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-white">
        <div className="bg-white p-8 rounded shadow max-w-lg w-full text-center text-lg font-medium">
          Thank you. Your intake form has been submitted. You can close this tab.
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-white">
      <form
        className="w-full max-w-xl bg-white p-8 rounded shadow flex flex-col gap-6"
        style={{ fontSize: 18 }}
        onSubmit={handleSubmit}
        autoComplete="off"
      >
        <div className="text-2xl font-bold text-center mb-2">{prefill?.clinicName || ''} — Patient Intake Form</div>
        <div className="flex flex-col gap-4">
          <label className="flex flex-col gap-1">
            <span>Full name <span className="text-red-500">*</span></span>
            <input
              type="text"
              name="fullName"
              value={form.fullName}
              onChange={handleChange}
              required
              className="border rounded px-3 py-2 text-lg"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span>Date of birth <span className="text-red-500">*</span></span>
            <input
              type="date"
              name="dob"
              value={form.dob}
              onChange={handleChange}
              required
              className="border rounded px-3 py-2 text-lg"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span>Phone number</span>
            <input
              type="tel"
              name="phone"
              value={form.phone}
              onChange={handleChange}
              className="border rounded px-3 py-2 text-lg"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span>Reason for visit <span className="text-red-500">*</span></span>
            <input
              type="text"
              name="reason"
              value={form.reason}
              onChange={handleChange}
              required
              className="border rounded px-3 py-2 text-lg"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span>Current medications</span>
            <textarea
              name="medications"
              value={form.medications}
              onChange={handleChange}
              placeholder="List any medications or 'None'"
              className="border rounded px-3 py-2 text-lg min-h-[60px]"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span>Known allergies</span>
            <textarea
              name="allergies"
              value={form.allergies}
              onChange={handleChange}
              placeholder="List any allergies or 'None'"
              className="border rounded px-3 py-2 text-lg min-h-[60px]"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span>Insurance provider</span>
            <input
              type="text"
              name="insuranceProvider"
              value={form.insuranceProvider}
              onChange={handleChange}
              className="border rounded px-3 py-2 text-lg"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span>Insurance member ID</span>
            <input
              type="text"
              name="insuranceMemberId"
              value={form.insuranceMemberId}
              onChange={handleChange}
              className="border rounded px-3 py-2 text-lg"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span>Emergency contact name</span>
            <input
              type="text"
              name="emergencyContactName"
              value={form.emergencyContactName}
              onChange={handleChange}
              className="border rounded px-3 py-2 text-lg"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span>Emergency contact phone</span>
            <input
              type="tel"
              name="emergencyContactPhone"
              value={form.emergencyContactPhone}
              onChange={handleChange}
              className="border rounded px-3 py-2 text-lg"
            />
          </label>
        </div>
        <button
          type="submit"
          className="mt-4 bg-blue-600 hover:bg-blue-700 text-white text-xl font-bold py-3 rounded w-full disabled:opacity-60"
          disabled={submitting}
        >
          {submitting ? 'Submitting...' : 'Submit'}
        </button>
        {error && <ErrorMessage message={error} />}
      </form>
    </div>
  );
};

export default IntakeFormPage;
