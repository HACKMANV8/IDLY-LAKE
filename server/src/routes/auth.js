import express from 'express';
import axios from 'axios';
import User from '../models/User.js';
import { encryptToken } from '../utils/crypto.js';
import { CONFIG } from '../config.js';

const router = express.Router();

router.get('/github', (req, res) => {
  const clientId = CONFIG.GITHUB_CLIENT_ID;
  const redirectUri = `${CONFIG.SERVER_URL}/auth/github/callback`;
  const scope = 'repo workflow';
  const url = `https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(
    clientId
  )}&scope=${encodeURIComponent(scope)}&redirect_uri=${encodeURIComponent(redirectUri)}`;
  res.redirect(url);
});

router.get('/github/callback', async (req, res) => {
  try {
    const { code } = req.query;
    if (!code) return res.status(400).json({ error: 'Missing code' });

    const tokenResp = await axios.post(
      'https://github.com/login/oauth/access_token',
      {
        client_id: CONFIG.GITHUB_CLIENT_ID,
        client_secret: CONFIG.GITHUB_CLIENT_SECRET,
        code,
        redirect_uri: `${CONFIG.SERVER_URL}/auth/github/callback`,
      },
      { headers: { Accept: 'application/json' } }
    );

    const accessToken = tokenResp.data.access_token;
    const scopeStr = tokenResp.data.scope || '';
    if (!accessToken) return res.status(400).json({ error: 'No access token' });

    // fetch user info
    const userResp = await axios.get('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${accessToken}`, 'User-Agent': 'mediator-app' },
    });

    const gh = userResp.data;
    const encryptedGithubToken = encryptToken(accessToken);

    const user = await User.findOneAndUpdate(
      { githubId: String(gh.id) },
      {
        username: gh.login,
        githubId: String(gh.id),
        encryptedGithubToken,
        tokenMeta: { scopes: scopeStr.split(',').filter(Boolean), obtainedAt: new Date() },
      },
      { new: true, upsert: true }
    );

    const redirectUrl = `${CONFIG.FRONTEND_URL}/connected?userId=${user._id}`;
    res.redirect(redirectUrl);
  } catch (err) {
    console.error('OAuth callback error', err?.response?.data || err);
    res.status(500).json({ error: 'OAuth failed' });
  }
});

export default router;


