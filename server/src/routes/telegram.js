import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import LinkCode from '../models/LinkCode.js';
import User from '../models/User.js';

const router = express.Router();

// Generate link code for a user (called from UI)
router.post('/generate-link-code', async (req, res) => {
  const { userId } = req.body || {};
  if (!userId) return res.status(400).json({ error: 'userId required' });
  const code = uuidv4().slice(0, 8);
  const doc = await LinkCode.create({ userId, code });
  res.json({ code: doc.code });
});

// Called by a Telegram bot backend to bind code -> telegramId
router.post('/link', async (req, res) => {
  const { code, telegramId } = req.body || {};
  if (!code || !telegramId) return res.status(400).json({ error: 'code and telegramId required' });
  const link = await LinkCode.findOne({ code });
  if (!link || link.usedAt) return res.status(400).json({ error: 'invalid or used code' });
  await User.findByIdAndUpdate(link.userId, { telegramId });
  link.usedAt = new Date();
  await link.save();
  res.json({ ok: true, userId: link.userId });
});

export default router;


