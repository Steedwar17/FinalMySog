require('dotenv').config();
const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;
const AUTH_URLS = parseAuthUrls(process.env.AUTH_URLS || process.env.AUTH_SERVICE_URL || 'http://localhost:4000');
const COORDINATOR_WS_URL = (process.env.COORDINATOR_WS_URL || '').trim();
const GOOGLE_CLIENT_ID = (process.env.GOOGLE_CLIENT_ID || '').trim();
let lastHealthyAuthUrl = AUTH_URLS[0];

app.use(express.json({ limit: '8kb' }));
app.use((req, res, next) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'unsafe-none');
  next();
});

function parseAuthUrls(raw) {
  const urls = String(raw || '')
    .split(',')
    .map((url) => normalizeBaseUrl(url))
    .filter(Boolean);

  return urls.length ? urls : ['http://localhost:4000'];
}

function normalizeBaseUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

function authUrl(baseUrl, pathname) {
  return new URL(pathname, `${baseUrl}/`).toString();
}

function buildProxyOptions(req, method) {
  const headers = {
    Accept: 'application/json',
    'ngrok-skip-browser-warning': 'true',
  };

  if (req.headers.authorization) {
    headers.Authorization = req.headers.authorization;
  }

  const options = { method, headers };

  if (method !== 'GET' && method !== 'HEAD') {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(req.body || {});
  }

  return options;
}

function tryParseJson(body) {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function normalizedErrorCode(payload) {
  return String((payload && (payload.error || payload.code)) || '')
    .toLowerCase()
    .replace(/[^a-z]/g, '');
}

function isNotLeader(payload) {
  const code = normalizedErrorCode(payload);
  return code === 'notleader' || code === 'notdleader';
}

function isServerError(status) {
  return status >= 500 && status <= 599;
}

function getLeaderUrl(payload) {
  if (!payload) return '';
  return payload.leaderUrl || payload.leaderURL || payload.leader_url || '';
}

async function proxyToAuth(req, res, pathname, method = req.method) {
  const options = buildProxyOptions(req, method);
  const attempted = [];
  const tried = new Set();
  let lastServerError = null;
  let lastNetworkError = null;

  async function tryAuth(baseUrl) {
    const cleanBaseUrl = normalizeBaseUrl(baseUrl);
    if (!cleanBaseUrl || tried.has(cleanBaseUrl)) return null;

    tried.add(cleanBaseUrl);
    attempted.push(cleanBaseUrl);

    try {
      const upstream = await fetch(authUrl(cleanBaseUrl, pathname), options);
      const body = await upstream.text();
      const payload = tryParseJson(body);

      const rawLeaderUrl = getLeaderUrl(payload);
      if (upstream.status === 503 && isNotLeader(payload) && rawLeaderUrl) {
        const leaderUrl = normalizeBaseUrl(rawLeaderUrl);
        const leaderResult = await tryAuth(leaderUrl);
        if (leaderResult) return leaderResult;
      }

      if (isServerError(upstream.status)) {
        lastServerError = {
          baseUrl: cleanBaseUrl,
          status: upstream.status,
          contentType: upstream.headers.get('content-type') || 'application/json',
          body,
        };
        return null;
      }

      return {
        baseUrl: cleanBaseUrl,
        status: upstream.status,
        contentType: upstream.headers.get('content-type') || 'application/json',
        body,
      };
    } catch (err) {
      lastNetworkError = { baseUrl: cleanBaseUrl, err };
      console.error(`[client] Error conectando con auth-service ${cleanBaseUrl}${pathname}: ${err.message}`);
      return null;
    }
  }

  for (const baseUrl of AUTH_URLS) {
    const result = await tryAuth(baseUrl);
    if (result) {
      lastHealthyAuthUrl = result.baseUrl;
      res.status(result.status);
      res.setHeader('Content-Type', result.contentType);
      res.setHeader('X-Auth-Url', result.baseUrl);
      res.setHeader('X-Auth-Attempts', attempted.join(','));
      res.send(result.body);
      return;
    }
  }

  if (lastServerError) {
    res.status(lastServerError.status);
    res.setHeader('Content-Type', lastServerError.contentType);
    res.setHeader('X-Auth-Url', lastServerError.baseUrl);
    res.setHeader('X-Auth-Attempts', attempted.join(','));
    res.send(lastServerError.body);
    return;
  }

  res.status(502).json({
    error: 'No se pudo conectar con ningun servicio de autenticacion',
    attemptedAuthUrls: attempted,
    lastError: lastNetworkError ? lastNetworkError.err.message : null,
  });
}

app.get('/config.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.send(`
    window.API_BASE_URL       = ${JSON.stringify('/api')};
    window.COORDINATOR_WS_URL = ${JSON.stringify(COORDINATOR_WS_URL)};
    window.GOOGLE_CLIENT_ID   = ${JSON.stringify(GOOGLE_CLIENT_ID)};
    window.AUTH_URLS          = ${JSON.stringify(AUTH_URLS)};
    window.AUTH_ACTIVE_URL    = ${JSON.stringify(lastHealthyAuthUrl)};
  `);
});

app.get('/api/auth/status', (req, res) => {
  res.json({
    activeUrl: lastHealthyAuthUrl,
    authUrls: AUTH_URLS,
  });
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
