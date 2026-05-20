require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const AUTH_SERVICE_URL = (process.env.AUTH_SERVICE_URL || 'http://localhost:4000').trim();
const COORDINATOR_WS_URL = (process.env.COORDINATOR_WS_URL || '').trim();
const GOOGLE_CLIENT_ID = (process.env.GOOGLE_CLIENT_ID || '').trim();

app.use(express.json({ limit: '8kb' }));

function authUrl(pathname) {
  return new URL(pathname, AUTH_SERVICE_URL.replace(/\/+$/, '') + '/').toString();
}

async function proxyToAuth(req, res, pathname, method = req.method) {
  const headers = {
    Accept: 'application/json',
  };

  if (req.headers.authorization) {
    headers.Authorization = req.headers.authorization;
  }

  const options = { method, headers };

  if (method !== 'GET' && method !== 'HEAD') {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(req.body || {});
  }

  try {
    const upstream = await fetch(authUrl(pathname), options);
    const contentType = upstream.headers.get('content-type') || 'application/json';
    const body = await upstream.text();

    res.status(upstream.status);
    res.setHeader('Content-Type', contentType);
    res.send(body);
  } catch (err) {
    console.error(`[client] Error conectando con auth-service ${pathname}: ${err.message}`);
    res.status(502).json({ error: 'No se pudo conectar con el servicio de autenticacion' });
  }
}

app.get('/config.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.send(`
    window.API_BASE_URL       = ${JSON.stringify('/api')};
    window.COORDINATOR_WS_URL = ${JSON.stringify(COORDINATOR_WS_URL)};
    window.GOOGLE_CLIENT_ID   = ${JSON.stringify(GOOGLE_CLIENT_ID)};
  `);
});

app.post('/api/register', (req, res) => proxyToAuth(req, res, '/register', 'POST'));
app.post('/api/login', (req, res) => proxyToAuth(req, res, '/login', 'POST'));
app.post('/api/auth/google', (req, res) => proxyToAuth(req, res, '/auth/google', 'POST'));
app.get('/api/coordinator', (req, res) => proxyToAuth(req, res, '/coordinator', 'GET'));

app.use(express.static(__dirname));


app.get('/', (req, res) => {
  res.redirect('/login.html');
});

app.listen(PORT, () => {
  console.log(`Cliente web en puerto ${PORT}`);
});
