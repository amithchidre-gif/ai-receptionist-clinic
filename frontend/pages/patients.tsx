
import React, { useEffect, useState, useRef } from 'react';
import { get } from '../services/apiClient';
import LoadingSpinner from '../components/LoadingSpinner';
import ErrorMessage from '../components/ErrorMessage';
import EmptyState from '../components/EmptyState';

interface Patient {
  id: string;
  clinicId: string;
  name: string;
  phone: string;
  dob?: string | null;
  createdAt: string;
  appointmentsCount?: number;
}

interface PatientDetail extends Patient {
  appointments: { id: string; date: string; time: string; status: string; formCompleted: boolean }[];
}

const PatientsPage: React.FC = () => {
  const [patients, setPatients] = useState<Patient[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [panelPatient, setPanelPatient] = useState<PatientDetail | null>(null);
  const [panelLoading, setPanelLoading] = useState(false);
  const debounceRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    fetchPatients();
    // eslint-disable-next-line
  }, []);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      fetchPatients(search);
    }, 300);
    // eslint-disable-next-line
  }, [search]);

  const fetchPatients = (q = '') => {
    setLoading(true);
    get(`/api/patients${q ? `?search=${encodeURIComponent(q)}` : ''}`)
      .then((res) => {
        setPatients(Array.isArray(res) ? res : []);
        setError(null);
      })
      .catch((err) => setError(err.message || 'Failed to load patients'))
      .finally(() => setLoading(false));
  };

  return (
    <div>
      <h2 className="text-lg font-semibold mb-4">Patients</h2>
      <input
        className="mb-4 px-3 py-2 border rounded w-full max-w-xs"
        placeholder="Search patients..."
        value={search}
        onChange={e => setSearch(e.target.value)}
      />
      {loading ? <LoadingSpinner /> : error ? <ErrorMessage message={error} /> : patients.length === 0 ? (
        <EmptyState message="No patients yet — they appear after the first call" />
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full bg-white rounded shadow">
            <thead>
              <tr className="text-left text-gray-600 border-b">
                <th className="py-2 px-4">Name</th>
                <th className="py-2 px-4">Phone</th>
                <th className="py-2 px-4">Date Joined</th>
                <th className="py-2 px-4">Appointments</th>
              </tr>
            </thead>
            <tbody>
              {patients.map((p) => (
                <tr
                  key={p.id}
                  className="border-b last:border-0 cursor-pointer hover:bg-blue-50"
                  onClick={() => {
                    setPanelLoading(true);
                    setPanelPatient({ ...p, appointments: [] });
                    get(`/api/patients/${p.id}`)
                      .then((detail) => setPanelPatient(detail))
                      .catch(() => {})
                      .finally(() => setPanelLoading(false));
                  }}
                >
                  <td className="py-2 px-4">{p.name}</td>
                  <td className="py-2 px-4">{maskPhone(p.phone)}</td>
                  <td className="py-2 px-4">{formatDate(p.createdAt)}</td>
                  <td className="py-2 px-4 text-center">{p.appointmentsCount ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {panelPatient && (
        <div className="fixed inset-0 bg-black bg-opacity-30 z-40 flex justify-end" onClick={() => setPanelPatient(null)}>
          <div className="bg-white w-full max-w-md h-full shadow-lg p-8 relative overflow-y-auto" onClick={e => e.stopPropagation()}>
            <button className="absolute top-4 right-4 text-gray-400 hover:text-gray-700 text-2xl" onClick={() => setPanelPatient(null)}>&times;</button>
            <h3 className="text-xl font-bold mb-4">{panelPatient.name}</h3>
            <div className="mb-2"><span className="font-semibold">DOB:</span> {panelPatient.dob ?? '—'}</div>
            <div className="mb-2"><span className="font-semibold">Phone:</span> {panelPatient.phone}</div>
            <div className="mb-2"><span className="font-semibold">Date Joined:</span> {formatDate(panelPatient.createdAt)}</div>
            <div className="mt-6">
              <h4 className="font-semibold mb-2">Recent Appointments</h4>
              {panelLoading ? (
                <div className="text-gray-400 text-sm">Loading...</div>
              ) : panelPatient.appointments.length === 0 ? (
                <div className="text-gray-400 text-sm">No appointments</div>
              ) : (
                <ul className="space-y-2">
                  {panelPatient.appointments.map((a) => (
                    <li key={a.id} className="border rounded px-3 py-2 text-sm">
                      <span className="font-medium">{a.date}</span> at {a.time}
                      <span className={`ml-2 px-2 py-0.5 rounded text-xs font-semibold ${
                        a.status === 'scheduled' ? 'bg-blue-100 text-blue-700' :
                        a.status === 'completed' ? 'bg-green-100 text-green-700' :
                        'bg-red-100 text-red-700'}`}>{a.status}</span>
                      {a.formCompleted && <span className="ml-2 text-green-600 text-xs">Form ✓</span>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

function maskPhone(phone: string) {
  if (!phone) return '—';
  return phone.replace(/\d(?=\d{4})/g, '*');
}
function formatDate(dateStr: string) {
  const d = new Date(dateStr);
  return d.toLocaleDateString();
}

export default PatientsPage;
