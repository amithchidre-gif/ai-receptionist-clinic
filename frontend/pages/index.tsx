import { useEffect } from 'react';
import { useRouter } from 'next/router';
import { isLoggedIn } from '../utils/auth';

export default function Home() {
  const router = useRouter();
  useEffect(() => {
    if (isLoggedIn()) {
      router.replace('/dashboard');
    } else {
      router.replace('/login');
    }
  }, [router]);
  return null;
}
