require('dotenv').config();

const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');
const Database = require('better-sqlite3');

// ── Configuración ──────────────────────────────────────────────────────────
const PORT           = parseInt(process.env.PORT || '4000', 10);
const JWT_SECRET     = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '1h';
const BCRYPT_ROUNDS  = parseInt(process.env.BCRYPT_ROUNDS || '10', 10);
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;

const corsOptions = {
  origin: process.env.CORS_ORIGINS,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
  optionsSuccessStatus: 200
};

if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error('[auth] FATAL: JWT_SECRET no definida o menor a 32 caracteres');
  process.exit(1);
}
if (!GOOGLE_CLIENT_ID) {
  console.error('[auth] FATAL: GOOGLE_CLIENT_ID no definida en .env');
  process.exit(1);
}

const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

// ── Base de datos ──────────────────────────────────────────────────────────
const db = new Database('users.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT UNIQUE NOT NULL,
    provider      TEXT NOT NULL CHECK(provider IN ('local','google')),
    password_hash TEXT,
    google_sub    TEXT UNIQUE,
    email         TEXT,
    created_at    TEXT DEFAULT CURRENT_TIMESTAMP
  )
`);

const stmts = {
  insertLocal:    db.prepare("INSERT INTO users (username, provider, password_hash) VALUES (?, 'local', ?)"),
  insertGoogle:   db.prepare("INSERT INTO users (username, provider, google_sub, email) VALUES (?, 'google', ?, ?)"),
  findByUsername: db.prepare('SELECT * FROM users WHERE username = ?'),
  findByGoogle:   db.prepare('SELECT * FROM users WHERE google_sub = ?'),
};

// ── Directory Service — coordinadores vivos ────────────────────────────────
// Map<coordinatorId, { publicUrl, peerUrl, connectedPlayers, uptime, lastSeen }>
const coordinators = new Map();
const HEARTBEAT_TIMEOUT = 6000; // 6 segundos = 3 ciclos de 2s

// Limpieza automática cada 2 segundos — elimina coordinadores muertos
setInterval(() => {
  const now = Date.now();
  for (const [id, info] of coordinators.entries()) {
    if (now - info.lastSeen > HEARTBEAT_TIMEOUT) {
      coordinators.delete(id);
      console.log(`[auth] Coordinador muerto eliminado: ${id}`);
    }
  }
}, 2000);

// ── Helpers ────────────────────────────────────────────────────────────────
function emitToken(user) {
  return jwt.sign(
    { userId: user.id, username: user.username, provider: user.provider },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

function validateUsername(u) {
  if (typeof u !== 'string') return 'username debe ser string';
  if (u.length < 3 || u.length > 32) return 'username debe tener entre 3 y 32 caracteres';
  if (!/^[a-zA-Z0-9_]+$/.test(u)) return 'username solo puede tener letras, numeros y _';
  return null;
}

// ── Express ────────────────────────────────────────────────────────────────
const app = express();
app.use(cors(corsOptions));
app.use(express.json({ limit: '4kb' }));
app.options('*', cors(corsOptions));

// ── Health check ───────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'auth-service' });
});

// ── POST /register ─────────────────────────────────────────────────────────
app.post('/register', async (req, res) => {
  const { username, password } = req.body ?? {};
  const usernameError = validateUsername(username);
  if (usernameError) return res.status(400).json({ error: usernameError });
  if (typeof password !== 'string' || password.length < 6) {
    return res.status(400).json({ error: 'password debe tener al menos 6 caracteres' });
  }
  try {
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const result = stmts.insertLocal.run(username.trim(), passwordHash);
    console.log(`[auth] Registrado (local): ${username} id=${result.lastInsertRowid}`);
    return res.status(201).json({ userId: result.lastInsertRowid, username: username.trim() });
  } catch (err) {
    if (err.message?.includes('UNIQUE constraint failed')) {
      return res.status(409).json({ error: 'El username ya esta registrado' });
    }
    console.error('[auth] Error en /register:', err.message);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── POST /login ────────────────────────────────────────────────────────────
app.post('/login', async (req, res) => {
  const { username, password } = req.body ?? {};
  if (typeof username !== 'string' || username.trim() === '') {
    return res.status(400).json({ error: 'username es requerido' });
  }
  if (typeof password !== 'string' || password === '') {
    return res.status(400).json({ error: 'password es requerido' });
  }
  try {
    const user = stmts.findByUsername.get(username.trim());
    const dummyHash = '$2b$10$invalidhashtopreventtimingattackxxxxxxxxxxxxxxxxxxxxxxxxx';
    const hashToCompare = user ? user.password_hash : dummyHash;
    const match = await bcrypt.compare(password, hashToCompare);
    if (!user || !match) {
      return res.status(401).json({ error: 'Credenciales invalidas' });
    }
    if (user.provider !== 'local') {
      return res.status(401).json({ error: 'Este usuario debe iniciar sesion con Google' });
    }
    console.log(`[auth] Login (local): ${user.username}`);
    return res.status(200).json({ token: emitToken(user), username: user.username });
  } catch (err) {
    console.error('[auth] Error en /login:', err.message);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── POST /auth/google ──────────────────────────────────────────────────────
app.post('/auth/google', async (req, res) => {
  const { idToken, username } = req.body ?? {};
  if (typeof idToken !== 'string') {
    return res.status(400).json({ error: 'idToken es requerido' });
  }
  let payload;
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: GOOGLE_CLIENT_ID,
    });
    payload = ticket.getPayload();
  } catch (err) {
    return res.status(401).json({ error: 'invalid_id_token' });
  }
  if (!payload.email_verified) {
    return res.status(401).json({ error: 'email_not_verified' });
  }
  const googleSub = payload.sub;
  const email     = payload.email;
  const existing = stmts.findByGoogle.get(googleSub);
  if (existing) {
    console.log(`[auth] Login (google): ${existing.username}`);
    return res.json({ token: emitToken(existing), username: existing.username });
  }
  if (!username) {
    return res.status(409).json({
      error: 'username_required',
      hint: 'Es tu primer ingreso con Google. Elige un username.',
    });
  }
  const usernameError = validateUsername(username);
  if (usernameError) {
    return res.status(400).json({ error: usernameError });
  }
  try {
    const result = stmts.insertGoogle.run(username.trim(), googleSub, email);
    const newUser = { id: result.lastInsertRowid, username: username.trim(), provider: 'google' };
    console.log(`[auth] Registrado (google): ${username} id=${result.lastInsertRowid}`);
    return res.json({ token: emitToken(newUser), username: newUser.username });
  } catch (err) {
    if (err.message?.includes('UNIQUE constraint failed')) {
      return res.status(409).json({ error: 'username_taken' });
    }
    console.error('[auth] Error en /auth/google:', err.message);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── POST /heartbeat ────────────────────────────────────────────────────────
// Lo llama cada coordinador cada 2 segundos para anunciar que sigue vivo
app.post('/heartbeat', (req, res) => {
  const { coordinatorId, publicUrl, peerUrl, connectedPlayers, uptime } = req.body ?? {};

  if (!coordinatorId || !publicUrl || !peerUrl) {
    return res.status(400).json({ error: 'coordinatorId, publicUrl y peerUrl son requeridos' });
  }

  coordinators.set(coordinatorId, {
    coordinatorId,
    publicUrl,
    peerUrl,
    connectedPlayers: connectedPlayers ?? 0,
    uptime: uptime ?? 0,
    lastSeen: Date.now(),
  });

  console.log(`[auth] Heartbeat de ${coordinatorId} — jugadores: ${connectedPlayers}`);
  return res.json({ ok: true });
});

// ── GET /coordinator ───────────────────────────────────────────────────────
// El cliente lo llama después del login para saber a qué coordinador conectarse
// Devuelve el coordinador con menos jugadores conectados (load balancing)
app.get('/coordinator', (req, res) => {
  const vivos = Array.from(coordinators.values());

  if (vivos.length === 0) {
    return res.status(503).json({ error: 'no_coordinators_available' });
  }

  // Ordenar por connectedPlayers ascendente — el primero tiene menos carga
  vivos.sort((a, b) => a.connectedPlayers - b.connectedPlayers);
  const elegido = vivos[0];

  console.log(`[auth] Cliente asignado a ${elegido.coordinatorId} (${elegido.connectedPlayers} jugadores)`);
  return res.json({
    coordinatorId: elegido.coordinatorId,
    publicUrl: elegido.publicUrl,
  });
});

// ── GET /peers ─────────────────────────────────────────────────────────────
// Lo llaman los coordinadores para descubrir sus pares en el mesh
app.get('/peers', (req, res) => {
  const peers = Array.from(coordinators.values()).map(c => ({
    coordinatorId: c.coordinatorId,
    peerUrl: c.peerUrl,
  }));

  return res.json({ peers });
});

// ── 404 ───────────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'Ruta no encontrada' });
});

// ── Arrancar ───────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[auth] Auth service corriendo en puerto ${PORT}`);
  console.log(`[auth] CORS permitiendo solo ${process.env.CORS_ORIGINS}`);
});