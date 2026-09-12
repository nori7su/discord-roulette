require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-key-change-this';
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;
const GAS_API_URL = process.env.GAS_API_URL;

// ユーザー認証ミドルウェア
function authenticateToken(req, res, next) {
  const token = req.cookies.auth_token;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid token' });
    req.user = user;
    next();
  });
}

// OAuth2 ログインリクエスト
app.get('/auth/discord', (req, res) => {
  const discordAuthUrl = `https://discord.com/api/oauth2/authorize?client_id=${DISCORD_CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=identify`;
  res.redirect(discordAuthUrl);
});

// OAuth2 コールバック処理 (Cookie保存でログイン維持)
app.get('/auth/discord/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send('No code provided');

  try {
    const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      body: new URLSearchParams({
        client_id: DISCORD_CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: REDIRECT_URI,
        scope: 'identify',
      }),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    const tokenData = await tokenResponse.json();
    const userResponse = await fetch('https://discord.com/api/users/@me', {
      headers: { authorization: `${tokenData.token_type} ${tokenData.access_token}` },
    });
    const userData = await userResponse.json();

    // 30日有効のJWTトークンを発行してCookieに保存
    const token = jwt.sign({ id: userData.id, username: userData.username }, JWT_SECRET, { expiresIn: '30d' });
    res.cookie('auth_token', token, { httpOnly: true, maxAge: 30 * 24 * 60 * 60 * 1000 });
    res.redirect('/');
  } catch (error) {
    console.error(error);
    res.status(500).send('Authentication failed');
  }
});

// ログイン状態および本日のプレイ状況チェック API
app.get('/api/user-status', authenticateToken, async (req, res) => {
  try {
    const response = await fetch(`${GAS_API_URL}?userId=${req.user.id}`);
    const data = await response.json();
    res.json({
      user: req.user,
      hasPlayedToday: data.hasPlayedToday,
      points: data.points
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch status from GAS' });
  }
});

// ルーレット実行 API (確率計算 & 結果判定)
app.post('/api/play-roulette', authenticateToken, async (req, res) => {
  try {
    // GAS側でプレイ状況を再確認
    const statusRes = await fetch(`${GAS_API_URL}?userId=${req.user.id}`);
    const statusData = await statusRes.json();

    if (statusData.hasPlayedToday) {
      return res.status(400).json({ error: '本日は既にプレイ済みです。' });
    }

    // 確率計算: 1pt (75%), 2pt (20%), 3pt (5%)
    const rand = Math.random();
    let point = 1;
    if (rand >= 0.75 && rand < 0.95) {
      point = 2;
    } else if (rand >= 0.95) {
      point = 3;
    }

    // GASにポイントを保存
    const gasRes = await fetch(GAS_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: req.user.id, points: point })
    });
    const gasData = await gasRes.json();

    if (gasData.success) {
      res.json({ point: point, message: '獲得おめでとうございます！' });
    } else {
      res.status(400).json({ error: gasData.message });
    }
  } catch (error) {
    res.status(500).json({ error: 'Server error during roulette' });
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));