import express from 'express';
import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import { CONFIG } from '../config.js';

const router = express.Router();

// Minimal helper endpoints for UI (no sessions/auth; demo-only)

router.get('/user', async (req, res) => {
  // For demo: accept userId via query
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: 'userId query required' });
  const user = await User.findById(userId).lean();
  if (!user) return res.status(404).json({ error: 'user not found' });
  res.json({ user: { _id: user._id, username: user.username, githubId: user.githubId, telegramId: user.telegramId } });
});

router.post('/request-mediator-token', async (req, res) => {
  const { userId, allowedActions } = req.body || {};
  if (!userId) return res.status(400).json({ error: 'userId required' });
  const token = jwt.sign({ sub: userId, actions: Array.isArray(allowedActions) ? allowedActions : [], tokenId: 'ui-' + Date.now() }, CONFIG.JWT_SECRET, { expiresIn: 60 * 10 });
  res.json({ mediatorJwt: token });
});

router.get('/user-by-telegram', async (req, res) => {
  const { telegramId } = req.query;
  if (!telegramId) return res.status(400).json({ error: 'telegramId required' });
  const user = await User.findOne({ telegramId: String(telegramId) }).lean();
  if (!user) return res.status(404).json({ error: 'not linked' });
  res.json({ user: { _id: user._id, username: user.username, githubId: user.githubId } });
});

export default router;


