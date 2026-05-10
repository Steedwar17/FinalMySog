require('dotenv').config();

const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');
const { DatabaseSync } = require('node:sqlite');

// ── Configuración ──────────────────────────────────────────────────────────────
const PORT           = parseInt(process.env.PORT || '4000', 10);
const JWT_SECRET     = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '1h';
const BCRYPT_ROUNDS  = parseInt(process.env.BCRYPT_ROUNDS || '10', 10);
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;

if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error('[auth] FATAL: JWT_SECRET no definida o menor a 32 caracteres');
  process.exit(1);
}
if (!GOOGLE_CLIENT_ID) {
  console.error('[auth] FATAL: GOOGLE_CLIENT_ID no definida en .env');
  process.exit(1);
}

const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

// ── Base de datos ──────────────────────────────────────────────────────────────
const db = new DatabaseSync('users.db');

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

// ── Helpers ────────────────────────────────────────────────────────────────────
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

// ── Express ────────────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json({ limit: '4kb' }));

// ── Health check ───────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'auth-service' });
});

// ── POST /register ─────────────────────────────────────────────────────────────
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

// ── POST /login ────────────────────────────────────────────────────────────────
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

    // Timing-safe: comparar aunque el usuario no exista
    const dummyHash = '$2b$10$invalidhashtopreventtimingattackxxxxxxxxxxxxxxxxxxxxxxxxx';
    const hashToCompare = user ? user.password_hash : dummyHash;
    const match = await bcrypt.compare(password, hashToCompare);

    if (!user || !match) {
      return res.status(401).json({ error: 'Credenciales invalidas' });
    }

    // Si el usuario es de Google no puede usar /login con password
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

// ── POST /auth/google ──────────────────────────────────────────────────────────
app.post('/auth/google', async (req, res) => {
  const { idToken, username } = req.body ?? {};

  if (typeof idToken !== 'string') {
    return res.status(400).json({ error: 'idToken es requerido' });
  }

  // 1. Verificar el ID token contra Google (valida firma + audience)
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

  // 2. El email debe estar verificado
  if (!payload.email_verified) {
    return res.status(401).json({ error: 'email_not_verified' });
  }

  const googleSub = payload.sub;   // identificador estable, no usar email
  const email     = payload.email;

  // 3. Ya existe este usuario de Google?
  const existing = stmts.findByGoogle.get(googleSub);
  if (existing) {
    console.log(`[auth] Login (google): ${existing.username}`);
    return res.json({ token: emitToken(existing), username: existing.username });
  }

  // 4. Primera vez: necesita elegir username
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

  // 5. Crear usuario de Google
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

// ── 404 ────────────────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'Ruta no encontrada' });
});

// ── Arrancar ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[auth] Auth service corriendo en puerto ${PORT}`);
});