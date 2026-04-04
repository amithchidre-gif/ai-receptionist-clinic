
import React, { useEffect, useState, useRef } from 'react';
import { get } from '../services/apiClient';

interface CallLogRow {
  id: string;
  fromNumber: string;
  status: string;
  startedAt: string | null;
  durationSeconds: number | null;
}
import LoadingSpinner from '../components/LoadingSpinner';
import ErrorMessage from '../components/ErrorMessage';
import EmptyState from '../components/EmptyState';

const statusColors: Record<string, string> = {
  completed: 'bg-green-100 text-green-700',
  missed: 'bg-red-100 text-red-700',
  in_progress: 'bg-yellow-100 text-yellow-700',
};

const CallsPage: React.FC = () => {
  const [calls, setCalls] = useState<CallLogRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    fetchCalls();
    intervalRef.current = setInterval(fetchCalls, 30000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
    // eslint-disable-next-line
  }, []);

  const fetchCalls = () => {
    get('/api/call-logs')
      .then((res) => {
        setCalls(Array.isArray(res) ? res : []);
        setError(null);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message || 'Failed to load calls');
        setLoading(false);
      });
  };

  if (loading) return <LoadingSpinner />;
  if (error) return <ErrorMessage message={error} />;

  return (
    <div>
      <h2 className="text-lg font-semibold mb-4">Calls</h2>
      {calls.length === 0 ? (
        <EmptyState message="No calls yet — once AI starts answering calls, they will appear here" />
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full bg-white rounded shadow">
            <thead>
              <tr className="text-left text-gray-600 border-b">
                <th className="py-2 px-4">From</th>
                <th className="py-2 px-4">Status</th>
                <th className="py-2 px-4">Date & Time</th>
                <th className="py-2 px-4">Duration</th>
              </tr>
            </thead>
            <tbody>
              {calls.map((call) => (
                <tr key={call.id} className="border-b last:border-0">
                  <td className="py-2 px-4">{maskPhone(call.fromNumber)}</td>
                  <td className="py-2 px-4">
                    <span className={`px-2 py-1 rounded text-xs font-semibold ${statusColors[call.status] || 'bg-gray-100 text-gray-500'}`}>{call.status.replace('_', ' ')}</span>
                  </td>
                  <td className="py-2 px-4">{call.startedAt ? formatDateTime(call.startedAt) : '—'}</td>
                  <td className="py-2 px-4">{formatDuration(call.durationSeconds)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

function maskPhone(phone: string) {
  if (!phone) return '—';
  return phone.replace(/\d(?=\d{4})/g, '*');
}
function formatDateTime(dateStr: string) {
  const d = new Date(dateStr);
  return d.toLocaleString();
}
function formatDuration(seconds: number | null) {
  if (seconds == null) return '—';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

export default CallsPage;
