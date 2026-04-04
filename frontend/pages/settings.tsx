
import React, { useEffect, useState } from 'react';
import { get, put } from '../services/apiClient';
import LoadingSpinner from '../components/LoadingSpinner';
import ErrorMessage from '../components/ErrorMessage';
import Toast from '../components/Toast';

interface Settings {
  clinicName: string;
  aiReceptionistEnabled: boolean;
  workingHours: string;
  phone: string;
  calendarId: string;
}


const SettingsPage: React.FC = () => {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

  useEffect(() => {
    get('/api/settings')
      .then((res) => {
        setSettings(res);
        setError(null);
      })
      .catch((err) => setError(err.message || 'Failed to load settings'))
      .finally(() => setLoading(false));
  }, []);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!settings) return;
    const { name, value, type, checked } = e.target;
    setSettings({
      ...settings,
      [name]: type === 'checkbox' ? checked : value,
    });
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!settings) return;
    setSaving(true);
    try {
      const updated = await put('/api/settings', settings);
      if (updated) setSettings(updated);
      setToast({ message: 'Settings saved', type: 'success' });
    } catch (e: any) {
      setToast({ message: e.message || 'Failed to save', type: 'error' });
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <LoadingSpinner />;
  if (error) return <ErrorMessage message={error} />;
  if (!settings) return null;

  return (
    <div className="max-w-xl mx-auto">
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
      <h2 className="text-lg font-semibold mb-4">Clinic Settings</h2>
      <form onSubmit={handleSave} className="space-y-6">
        <div>
          <label className="block font-medium mb-1">Clinic Name</label>
          <input
            className="w-full border rounded px-3 py-2"
            name="clinicName"
            value={settings.clinicName ?? ''}
            onChange={handleChange}
            required
          />
        </div>
        <div className="flex items-center space-x-3">
          <label className="font-medium">AI Enabled</label>
          <input
            type="checkbox"
            name="aiReceptionistEnabled"
            checked={!!settings.aiReceptionistEnabled}
            onChange={handleChange}
            className="h-5 w-5"
          />
        </div>
        <div>
          <label className="block font-medium mb-1">Working Hours</label>
          <input
            className="w-full border rounded px-3 py-2"
            name="workingHours"
            value={settings.workingHours ?? ''}
            onChange={handleChange}
          />
        </div>
        <div>
          <label className="block font-medium mb-1">Telnyx Phone Number</label>
          <input
            className="w-full border rounded px-3 py-2"
            name="phone"
            value={settings.phone ?? ''}
            onChange={handleChange}
          />
        </div>
        <div>
          <label className="block font-medium mb-1">Google Calendar ID</label>
          <input
            className="w-full border rounded px-3 py-2"
            name="calendarId"
            value={settings.calendarId ?? ''}
            onChange={handleChange}
          />
          <div className="text-xs text-gray-500 mt-1">
            Share your Google Calendar with the service account email, then paste the calendar ID here (found in Google Calendar settings)
          </div>
        </div>
        <button
          type="submit"
          className={`w-full py-2 rounded text-white font-semibold ${saving ? 'bg-gray-400' : 'bg-blue-600 hover:bg-blue-700'}`}
          disabled={saving}
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
      </form>
    </div>
  );
};

export default SettingsPage;
