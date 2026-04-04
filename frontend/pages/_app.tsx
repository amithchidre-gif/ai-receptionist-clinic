import type { AppProps } from 'next/app';
import Layout from '../components/Layout';
import '../styles/globals.css';
import { useRouter } from 'next/router';

function MyApp({ Component, pageProps }: AppProps) {
  const router = useRouter();
  // Don't wrap /login, /intake/*, or /test-scorecard with Layout
  const isAuthPage =
    router.pathname === '/login' ||
    router.pathname.startsWith('/intake') ||
    router.pathname === '/test-scorecard';
  if (isAuthPage) {
    return <Component {...pageProps} />;
  }
  return (
    <Layout>
      <Component {...pageProps} />
    </Layout>
  );
}

export default MyApp;
