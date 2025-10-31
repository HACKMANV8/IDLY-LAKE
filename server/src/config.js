// Central config with hardcoded fallbacks. Environment variables override when present.

export const CONFIG = {
  MONGODB_URI: process.env.MONGODB_URI || 'mongodb+srv://mahi13singh2004:Mahisingh13@cluster0.8ja9gqo.mongodb.net/mediator_dev?retryWrites=true&w=majority&appName=Cluster0',
  JWT_SECRET: process.env.JWT_SECRET || 'dev-jwt-secret-please-change',
  ENCRYPTION_KEY_BASE64: process.env.ENCRYPTION_KEY_BASE64 || '5iZtE0mN3rWbPq2x6S7O3FvZP4h8G2V0wq1y5t6u8x0z3c5v7b9d1f3h5j7l9n==',
  GITHUB_CLIENT_ID: process.env.GITHUB_CLIENT_ID || '',
  GITHUB_CLIENT_SECRET: process.env.GITHUB_CLIENT_SECRET || '',
  SERVER_URL: process.env.SERVER_URL || 'http://localhost:3001',
  FRONTEND_URL: process.env.FRONTEND_URL || 'http://localhost:5173',
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
  PORT: process.env.PORT || 3001,
};


