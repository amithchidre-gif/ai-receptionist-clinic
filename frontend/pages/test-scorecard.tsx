import React, { useState } from 'react';
import Head from 'next/head';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Result = 'pass' | 'fail' | 'skip' | null;

interface TestItem {
  id: number;
  label: string;
}

interface RowState {
  result: Result;
  notes: string;
  notesOpen: boolean;
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

const TEST_ITEMS: TestItem[] = [
  { id: 1,  label: 'Greeting sounds natural and warm' },
  { id: 2,  label: 'Intent detected correctly on first try' },
  { id: 3,  label: 'Name captured without asking to repeat' },
  { id: 4,  label: 'Name spelled back correctly by AI' },
  { id: 5,  label: 'Patient able to confirm or correct name' },
  { id: 6,  label: 'Date of birth captured correctly' },
  { id: 7,  label: 'Phone number captured correctly' },
  { id: 8,  label: 'Appointment date and time confirmed clearly' },
  { id: 9,  label: 'Booking confirmed — no awkward pause' },
  { id: 10, label: 'Confirmation SMS received within 30 seconds' },
  { id: 11, label: 'Emergency phrase triggered 911 response immediately' },
];

const LATENCY_OPTIONS = [
  'Excellent (under 1s)',
  'Good (1–2s)',
  'Noticeable (2–3s)',
  'Too slow (over 3s)',
];

const IMPRESSION_OPTIONS = [
  'Ready to pitch',
  'Needs minor fixes',
  'Needs major work',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function today(): string {
  return new Date().toLocaleDateString('en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

function resultLabel(r: Result): string {
  if (r === 'pass') return 'PASS';
  if (r === 'fail') return 'FAIL';
  if (r === 'skip') return 'SKIP';
  return '—';
}

// ---------------------------------------------------------------------------
// StarRating sub-component
// ---------------------------------------------------------------------------

function StarRating({
  value,
  onChange,
}: {
  value: number;
  onChange: (v: number) => void;
}) {
  const [hovered, setHovered] = useState(0);
  return (
    <span className="flex gap-1">
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          aria-label={`${n} star${n > 1 ? 's' : ''}`}
          onMouseEnter={() => setHovered(n)}
          onMouseLeave={() => setHovered(0)}
          onClick={() => onChange(n)}
          className="text-2xl leading-none focus:outline-none"
        >
          <span className={(hovered ? n <= hovered : n <= value) ? 'text-yellow-400' : 'text-gray-300'}>
            ★
          </span>
        </button>
      ))}
      <span className="ml-1 text-sm text-gray-500 self-center">{value > 0 ? `${value}/5` : ''}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function TestScorecard() {
  const [tester, setTester] = useState('');
  const [testDate, setTestDate] = useState(today());
  const [rows, setRows] = useState<Record<number, RowState>>(() =>
    Object.fromEntries(
      TEST_ITEMS.map((t) => [t.id, { result: null, notes: '', notesOpen: false }]),
    ),
  );
  const [latency, setLatency] = useState('');
  const [stars, setStars] = useState(0);
  const [impression, setImpression] = useState('');
  const [freeNotes, setFreeNotes] = useState('');
  const [copied, setCopied] = useState(false);

  // --- row helpers ---

  function setResult(id: number, result: Result) {
    setRows((prev) => ({
      ...prev,
      [id]: { ...prev[id], result },
    }));
  }

  function setNotes(id: number, notes: string) {
    setRows((prev) => ({ ...prev, [id]: { ...prev[id], notes } }));
  }

  function toggleNotes(id: number) {
    setRows((prev) => ({
      ...prev,
      [id]: { ...prev[id], notesOpen: !prev[id].notesOpen },
    }));
  }

  // --- copy to clipboard ---

  function buildText(): string {
    const sep = '─────────────────────────────────────────';
    const header = `AI Receptionist Test — ${testDate} — ${tester || '(no tester)'}`;

    const lines = TEST_ITEMS.map((t) => {
      const row = rows[t.id];
      const status = resultLabel(row.result);
      const noteStr = row.notes.trim() ? ` — ${row.notes.trim()}` : '';
      const num = String(t.id).padStart(2, ' ');
      return `${num}. ${t.label.padEnd(45)}${status}${noteStr}`;
    });

    const assessments = [
      `Latency: ${latency || '—'}`,
      `Voice: ${stars > 0 ? `${stars}/5` : '—'}`,
      `Overall: ${impression || '—'}`,
      `Notes: ${freeNotes.trim() || '—'}`,
    ];

    return [header, sep, ...lines, sep, ...assessments].join('\n');
  }

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(buildText());
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      // Fallback for environments without clipboard API
      const ta = document.createElement('textarea');
      ta.value = buildText();
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    }
  }

  // --- result button styles ---

  function btnCls(rowResult: Result, type: Result): string {
    const active = rowResult === type;
    const base = 'px-3 py-1 rounded text-sm font-medium border transition-colors focus:outline-none';
    if (type === 'pass')
      return `${base} ${active ? 'bg-green-600 text-white border-green-600' : 'bg-white text-green-700 border-green-300 hover:bg-green-50'}`;
    if (type === 'fail')
      return `${base} ${active ? 'bg-red-600 text-white border-red-600' : 'bg-white text-red-700 border-red-300 hover:bg-red-50'}`;
    return `${base} ${active ? 'bg-gray-500 text-white border-gray-500' : 'bg-white text-gray-500 border-gray-300 hover:bg-gray-50'}`;
  }

  return (
    <>
      <Head>
        <title>Voice Agent Test Scorecard</title>
      </Head>
      <div className="min-h-screen bg-white py-10 px-4">
        <div className="max-w-2xl mx-auto">
          {/* Header */}
          <h1 className="text-2xl font-bold text-gray-900 mb-1">Voice Agent Test Scorecard</h1>
          <p className="text-sm text-gray-500 mb-8">Fill this in during each test call</p>

          {/* Tester / Date */}
          <div className="flex gap-4 mb-8">
            <div className="flex-1">
              <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">
                Tester name
              </label>
              <input
                type="text"
                value={tester}
                onChange={(e) => setTester(e.target.value)}
                placeholder="Your name"
                className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
              />
            </div>
            <div className="flex-1">
              <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">
                Test date
              </label>
              <input
                type="text"
                value={testDate}
                onChange={(e) => setTestDate(e.target.value)}
                className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
              />
            </div>
          </div>

          {/* Test table */}
          <div className="border border-gray-200 rounded-lg overflow-hidden mb-8">
            <table className="w-full">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  <th className="text-left px-4 py-2 text-xs font-semibold text-gray-500 uppercase tracking-wide w-8">#</th>
                  <th className="text-left px-4 py-2 text-xs font-semibold text-gray-500 uppercase tracking-wide">Test</th>
                  <th className="text-right px-4 py-2 text-xs font-semibold text-gray-500 uppercase tracking-wide">Result</th>
                </tr>
              </thead>
              <tbody>
                {TEST_ITEMS.map((item, idx) => {
                  const row = rows[item.id];
                  const isLast = idx === TEST_ITEMS.length - 1;
                  return (
                    <React.Fragment key={item.id}>
                      <tr
                        className={`${isLast ? '' : 'border-b border-gray-100'} hover:bg-gray-50 cursor-pointer`}
                        onClick={() => toggleNotes(item.id)}
                      >
                        <td className="px-4 py-3 text-sm text-gray-400 align-top">{item.id}</td>
                        <td className="px-4 py-3 text-sm text-gray-800 align-top select-none">
                          {item.label}
                        </td>
                        <td className="px-4 py-3 align-top">
                          <div className="flex gap-1 justify-end" onClick={(e) => e.stopPropagation()}>
                            <button className={btnCls(row.result, 'pass')} onClick={() => setResult(item.id, row.result === 'pass' ? null : 'pass')}>Pass</button>
                            <button className={btnCls(row.result, 'fail')} onClick={() => setResult(item.id, row.result === 'fail' ? null : 'fail')}>Fail</button>
                            <button className={btnCls(row.result, 'skip')} onClick={() => setResult(item.id, row.result === 'skip' ? null : 'skip')}>Skip</button>
                          </div>
                        </td>
                      </tr>
                      {row.notesOpen && (
                        <tr className={`bg-gray-50 ${isLast ? '' : 'border-b border-gray-100'}`}>
                          <td />
                          <td colSpan={2} className="px-4 pb-3">
                            <input
                              type="text"
                              value={row.notes}
                              onChange={(e) => setNotes(item.id, e.target.value)}
                              onClick={(e) => e.stopPropagation()}
                              placeholder="Notes (optional)…"
                              className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
                              autoFocus
                            />
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Assessment fields */}
          <div className="space-y-5 mb-8">
            {/* Latency */}
            <div>
              <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">
                Latency feel
              </label>
              <select
                value={latency}
                onChange={(e) => setLatency(e.target.value)}
                className="border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400 bg-white"
              >
                <option value="">— select —</option>
                {LATENCY_OPTIONS.map((o) => (
                  <option key={o} value={o}>{o}</option>
                ))}
              </select>
            </div>

            {/* Voice naturalness */}
            <div>
              <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">
                Voice naturalness
              </label>
              <StarRating value={stars} onChange={setStars} />
            </div>

            {/* Overall impression */}
            <div>
              <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">
                Overall impression
              </label>
              <select
                value={impression}
                onChange={(e) => setImpression(e.target.value)}
                className="border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400 bg-white"
              >
                <option value="">— select —</option>
                {IMPRESSION_OPTIONS.map((o) => (
                  <option key={o} value={o}>{o}</option>
                ))}
              </select>
            </div>

            {/* Free notes */}
            <div>
              <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">
                Free notes
              </label>
              <textarea
                value={freeNotes}
                onChange={(e) => setFreeNotes(e.target.value)}
                rows={3}
                placeholder="Anything the AI said that sounded wrong…"
                className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400 resize-none"
              />
            </div>
          </div>

          {/* Copy button */}
          <button
            type="button"
            onClick={handleCopy}
            className={`px-6 py-2.5 rounded font-semibold text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-blue-400 ${
              copied
                ? 'bg-green-600 text-white'
                : 'bg-blue-600 text-white hover:bg-blue-700'
            }`}
          >
            {copied ? 'Copied!' : 'Copy Results'}
          </button>
        </div>
      </div>
    </>
  );
}
