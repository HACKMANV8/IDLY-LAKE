

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
dotenv.config({ path: path.join(rootDir, '.env') });
console.log('env loaded from', path.join(rootDir, '.env'), 'MONGODB_URI set?', !!process.env.MONGODB_URI);

import express from 'express';
import cors from 'cors';
import mongoose from 'mongoose';

import authRouter from './routes/auth.js';
import mediatorRouter from './routes/mediator.js';
import uiRouter from './routes/ui.js';
import telegramRouter from './routes/telegram.js';
import { CONFIG } from './config.js';

const app = express();

app.use(cors({ origin: CONFIG.FRONTEND_URL?.split(',') || '*', credentials: true }));
app.use(express.json());

const mongoUri = CONFIG.MONGODB_URI;

mongoose
  .connect(mongoUri)
  .then(() => console.log('MongoDB connected'))
  .catch((err) => {
    
    console.error('MongoDB connection error', err.message);
    process.exit(1);
  });

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.use('/auth', authRouter);
app.use('/mediator', mediatorRouter);
app.use('/api', uiRouter);
app.use('/telegram', telegramRouter);

const port = CONFIG.PORT;
app.listen(port, () => {
  console.log(`Server listening on http://localhost:${port}`);
});


