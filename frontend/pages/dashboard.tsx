
import React, { useEffect, useState } from 'react';
import { get } from '../services/apiClient';
import LoadingSpinner from '../components/LoadingSpinner';
import ErrorMessage from '../components/ErrorMessage';
import EmptyState from '../components/EmptyState';

const statusColors: Record<string, string> = {
  completed: 'bg-green-100 text-green-700',
  missed: 'bg-red-100 text-red-700',
  in_progress: 'bg-yellow-100 text-yellow-700',
};

interface RecentCall {
  id: string;
  fromNumber: string;
  status: string;
  startedAt: string | null;
  durationSeconds: number | null;
}

interface DashboardData {
  totalCallsToday: number;
  appointmentsToday: number;
  appointmentsThisWeek: number;
  newPatientsThisWeek: number;
  pendingForms: number;
  recentCalls: RecentCall[];
}

const DashboardPage: React.FC = () => {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    get('/api/dashboard')
      .then((res) => {
        setData(res);
        setError(null);
      })
      .catch((err) => setError(err.message || 'Failed to load dashboard'))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <LoadingSpinner />;
  if (error) return <ErrorMessage message={error} />;
  if (!data) return null;

  const statCards = [
    { label: 'Total Calls Today', value: data.totalCallsToday ?? 0 },
    { label: 'Appointments Today', value: data.appointmentsToday ?? 0 },
    { label: 'This Week', value: data.appointmentsThisWeek ?? 0 },
    { label: 'New Patients', value: data.newPatientsThisWeek ?? 0 },
    { label: 'Pending Forms', value: data.pendingForms ?? 0 },
    { label: '', value: '' },
  ];

  const recentCalls: RecentCall[] = data.recentCalls ?? [];

  return (
    <div>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-6 mb-10">
        {statCards.map((card, i) => (
          <div key={i} className="bg-white rounded-lg shadow p-6 flex flex-col items-center justify-center min-h-[100px]">
            <div className="text-2xl font-bold mb-1">{card.value}</div>
            <div className="text-gray-500 text-sm">{card.label}</div>
          </div>
        ))}
      </div>

      <div className="mt-8">
        <h2 className="text-lg font-semibold mb-4">Recent Calls</h2>
        {recentCalls.length === 0 ? (
          <EmptyState message="No activity yet — once the AI starts answering calls, stats will appear here" />
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full bg-white rounded shadow">
              <thead>
                <tr className="text-left text-gray-600 border-b">
                  <th className="py-2 px-4">From</th>
                  <th className="py-2 px-4">Status</th>
                  <th className="py-2 px-4">Time</th>
                  <th className="py-2 px-4">Duration</th>
                </tr>
              </thead>
              <tbody>
                {recentCalls.map((call) => (
                  <tr key={call.id} className="border-b last:border-0">
                    <td className="py-2 px-4">{call.fromNumber}</td>
                    <td className="py-2 px-4">
                      <span className={`px-2 py-1 rounded text-xs font-semibold ${statusColors[call.status] || 'bg-gray-100 text-gray-500'}`}>{call.status.replace('_', ' ')}</span>
                    </td>
                    <td className="py-2 px-4">{call.startedAt ? formatTime(call.startedAt) : '—'}</td>
                    <td className="py-2 px-4">{formatDuration(call.durationSeconds)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};

function formatTime(dateStr: string) {
  const d = new Date(dateStr);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDuration(seconds: number | null) {
  if (seconds == null) return '—';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

export default DashboardPage;
