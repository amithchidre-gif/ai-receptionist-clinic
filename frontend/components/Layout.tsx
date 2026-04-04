import React, { ReactNode, useEffect } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { isLoggedIn, getClinicId, removeToken, removeClinicId } from '../utils/auth';

const navLinks = [
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/appointments', label: 'Appointments' },
  { href: '/patients', label: 'Patients' },
  { href: '/calls', label: 'Calls' },
  { href: '/forms', label: 'Forms' },
  { href: '/settings', label: 'Settings' },
];

interface LayoutProps {
  children: ReactNode;
}

const Layout: React.FC<LayoutProps> = ({ children }) => {
  const router = useRouter();
  const clinicName = (typeof window !== 'undefined' && localStorage.getItem('clinicName')) || 'Clinic';

  useEffect(() => {
    if (!isLoggedIn() && router.pathname !== '/login') {
      router.push('/login');
    }
  }, [router]);

  const handleLogout = () => {
    removeToken();
    removeClinicId();
    router.push('/login');
  };

  return (
    <div className="min-h-screen flex bg-gray-50">
      {/* Sidebar */}
      <aside className="w-56 bg-white border-r flex flex-col py-6 px-4">
        <div className="font-bold text-lg mb-8 text-blue-700">AI Receptionist</div>
        <nav className="flex-1">
          <ul className="space-y-2">
            {navLinks.map((link) => (
              <li key={link.href}>
                <Link href={link.href}>
                  <span className={`block px-3 py-2 rounded-md cursor-pointer ${router.pathname === link.href ? 'bg-blue-100 text-blue-700 font-semibold' : 'text-gray-700 hover:bg-gray-100'}`}>{link.label}</span>
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </aside>
      {/* Main content */}
      <div className="flex-1 flex flex-col">
        {/* Top bar */}
        <header className="flex items-center justify-between h-16 px-8 bg-white border-b">
          <div className="font-semibold text-gray-700">{clinicName}</div>
          <button onClick={handleLogout} className="text-sm text-red-600 hover:underline">Logout</button>
        </header>
        <main className="flex-1 p-8">{children}</main>
      </div>
    </div>
  );
};

export default Layout;
