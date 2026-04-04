import 'dotenv/config';
import './src/config/env';
console.log('✓ Environment loaded successfully');
console.log('DATABASE_URL:', process.env.DATABASE_URL ? 'present' : 'missing');
