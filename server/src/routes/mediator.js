import express from 'express';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import axios from 'axios';
import User from '../models/User.js';
import MediatorAudit from '../models/MediatorAudit.js';
import { decryptToken } from '../utils/crypto.js';
import { CONFIG } from '../config.js';

const router = express.Router();

const ALLOWED_ACTIONS = new Set(['read_repo', 'list_prs', 'create_repo', 'delete_repo']);

router.get('/ping', (req, res) => {
  res.json({ ok: true });
});

router.post('/issue-temp-token', async (req, res) => {
  try {
    const { userId, allowedActions, expiresIn } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'userId required' });
    const actions = Array.isArray(allowedActions) ? allowedActions.filter((a) => ALLOWED_ACTIONS.has(a)) : [];
    const tokenId = uuidv4();
    const payload = {
      sub: String(userId),
      actions,
      tokenId,
    };
    const token = jwt.sign(payload, CONFIG.JWT_SECRET, { expiresIn: Math.min(expiresIn || 900, 1800) });
    res.json({ mediatorJwt: token });
  } catch (err) {
    console.error('issue-temp-token error', err);
    res.status(500).json({ error: 'failed to issue token' });
  }
});

router.post('/exec', async (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  let auditBase = { ip: String(ip || '') };
  try {
    const { mediatorJwt, action, payload } = req.body || {};
    if (!mediatorJwt || !action) return res.status(400).json({ error: 'mediatorJwt and action required' });
    const decoded = jwt.verify(mediatorJwt, CONFIG.JWT_SECRET);
    if (!decoded?.actions?.includes(action)) {
      await MediatorAudit.create({ ...auditBase, userId: decoded?.sub, action, tokenId: decoded?.tokenId, success: false, status: 403, meta: { reason: 'not allowed' } });
      return res.status(403).json({ error: 'action not allowed' });
    }

    const user = await User.findById(decoded.sub);
    if (!user?.encryptedGithubToken) {
      await MediatorAudit.create({ ...auditBase, userId: decoded?.sub, action, tokenId: decoded?.tokenId, success: false, status: 404, meta: { reason: 'user/token not found' } });
      return res.status(404).json({ error: 'user/token not found' });
    }

    const githubToken = decryptToken(user.encryptedGithubToken);
    const ghHeaders = { Authorization: `Bearer ${githubToken}`, 'User-Agent': 'mediator-app', Accept: 'application/vnd.github+json' };

    if (action === 'read_repo') {
      const gh = await axios.get('https://api.github.com/user/repos?per_page=100', { headers: ghHeaders });
      await MediatorAudit.create({ ...auditBase, userId: user._id, action, tokenId: decoded?.tokenId, success: true, status: 200 });
      return res.json({ repos: gh.data });
    }

    if (action === 'create_repo') {
      const { name, description = '', private: isPrivate = false } = payload || {};
      if (!name) {
        await MediatorAudit.create({ ...auditBase, userId: user._id, action, tokenId: decoded?.tokenId, success: false, status: 400, meta: { reason: 'name required' } });
        return res.status(400).json({ error: 'name required' });
      }
      const gh = await axios.post('https://api.github.com/user/repos', { name, description, private: !!isPrivate }, { headers: ghHeaders });
      await MediatorAudit.create({ ...auditBase, userId: user._id, action, tokenId: decoded?.tokenId, success: true, status: 201 });
      return res.status(201).json({ repo: gh.data });
    }

    if (action === 'delete_repo') {
      const { owner, repo } = payload || {};
      const ownerName = owner || user.username;
      if (!ownerName || !repo) {
        await MediatorAudit.create({ ...auditBase, userId: user._id, action, tokenId: decoded?.tokenId, success: false, status: 400, meta: { reason: 'owner/repo required' } });
        return res.status(400).json({ error: 'owner/repo required' });
      }
      const url = `https://api.github.com/repos/${encodeURIComponent(ownerName)}/${encodeURIComponent(repo)}`;
      await axios.delete(url, { headers: ghHeaders });
      await MediatorAudit.create({ ...auditBase, userId: user._id, action, tokenId: decoded?.tokenId, success: true, status: 200 });
      return res.json({ ok: true });
    }

    if (action === 'list_prs') {
      const { owner, repo, state = 'open' } = payload || {};
      if (!owner || !repo) {
        await MediatorAudit.create({ ...auditBase, userId: user._id, action, tokenId: decoded?.tokenId, success: false, status: 400, meta: { reason: 'owner/repo required' } });
        return res.status(400).json({ error: 'owner and repo required' });
      }
      const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?state=${encodeURIComponent(state)}`;
      const gh = await axios.get(url, { headers: ghHeaders });
      await MediatorAudit.create({ ...auditBase, userId: user._id, action, tokenId: decoded?.tokenId, success: true, status: 200 });
      return res.json({ prs: gh.data });
    }

    await MediatorAudit.create({ ...auditBase, userId: user._id, action, tokenId: decoded?.tokenId, success: false, status: 400, meta: { reason: 'unknown action' } });
    return res.status(400).json({ error: 'unknown action' });
  } catch (err) {
    console.error('exec error', err?.response?.data || err?.message || err);
    try {
      const { mediatorJwt, action } = req.body || {};
      const decoded = mediatorJwt ? jwt.decode(mediatorJwt) : {};
      await MediatorAudit.create({ ip: String(ip || ''), userId: decoded?.sub, action, tokenId: decoded?.tokenId, success: false, status: 500, meta: { error: String(err?.message || err) } });
    } catch (_) {}
    res.status(500).json({ error: 'mediator exec failed' });
  }
});

export default router;


