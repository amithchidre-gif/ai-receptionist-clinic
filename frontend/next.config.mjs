/** @type {import('next').NextConfig} */
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:4000';

const nextConfig = {
  eslint: {
    // Lint errors should not block production Docker builds
    ignoreDuringBuilds: true,
  },
  typescript: {
    // Type errors should not block production Docker builds
    ignoreBuildErrors: true,
  },
  async rewrites() {
    return [
      // Patient-facing intake form token lookup (no auth)
      {
        source: '/form/:token*',
        destination: `${BACKEND_URL}/form/:token*`,
      },
      // Form submission and all other /api/forms/* routes
      {
        source: '/api/forms/:path*',
        destination: `${BACKEND_URL}/api/forms/:path*`,
      },
    ];
  },
};

export default nextConfig;
