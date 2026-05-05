require('dotenv').config();

const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

// ── Configuración ──────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET;
const BCRYPT_ROUNDS = 10;

if (!JWT_SECRET) {
  console.error('[auth] FATAL: JWT_SECRET no definida en .env');
  process.exit(1);
}

// ── Base de datos ──────────────────────────────────────────────────────────────
const db = new Database('users.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    username     TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at   TEXT DEFAULT CURRENT_TIMESTAMP
  )
`);

// Prepared statements reutilizables
const stmtFindByUsername = db.prepare('SELECT id, username, password_hash FROM users WHERE username = ?');
const stmtInsertUser     = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)');

// ── Express ────────────────────────────────────────────────────────────────────
const app = express();

app.use(cors());
app.use(express.json());

// ── Health check (útil para que el coordinador verifique que auth está vivo) ──
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'auth-service' });
});

// ── POST /register ─────────────────────────────────────────────────────────────
app.post('/register', async (req, res) => {
  const { username, password } = req.body ?? {};

  // Validación de body
  if (typeof username !== 'string' || username.trim() === '') {
    return res.status(400).json({ error: 'username es requerido y debe ser texto' });
  }
  if (typeof password !== 'string' || password.length < 6) {
    return res.status(400).json({ error: 'password es requerido y debe tener al menos 6 caracteres' });
  }

  const cleanUsername = username.trim();

  try {
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    const result = stmtInsertUser.run(cleanUsername, passwordHash);

    console.log(`[auth] Nuevo usuario registrado: ${cleanUsername} (id=${result.lastInsertRowid})`);

    return res.status(201).json({
      userId: result.lastInsertRowid,
      username: cleanUsername,
    });

  } catch (err) {
    // SQLite lanza error con código SQLITE_CONSTRAINT cuando el username ya existe
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE' || err.message?.includes('UNIQUE constraint failed')) {
      return res.status(409).json({ error: 'El username ya está registrado' });
    }
    console.error('[auth] Error en /register:', err.message);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── POST /login ────────────────────────────────────────────────────────────────
app.post('/login', async (req, res) => {
  const { username, password } = req.body ?? {};

  // Validación de body
  if (typeof username !== 'string' || username.trim() === '') {
    return res.status(400).json({ error: 'username es requerido' });
  }
  if (typeof password !== 'string' || password === '') {
    return res.status(400).json({ error: 'password es requerido' });
  }

  const cleanUsername = username.trim();

  try {
    const user = stmtFindByUsername.get(cleanUsername);

    // Usamos bcrypt.compare incluso si el usuario no existe para evitar timing attacks
    const dummyHash = '$2b$10$invalidhashtopreventtimingattack00000000000000000000000';
    const hashToCompare = user ? user.password_hash : dummyHash;

    const passwordMatch = await bcrypt.compare(password, hashToCompare);

    if (!user || !passwordMatch) {
      // Mensaje genérico: no revelamos si el username existe o no
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    // Emitir JWT con expiración de 1 hora
    const payload = {
      userId:   user.id,
      username: user.username,
    };

    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '1h' });

    console.log(`[auth] Login exitoso: ${user.username} (id=${user.id})`);

    return res.status(200).json({
      token,
      username: user.username,
    });

  } catch (err) {
    console.error('[auth] Error en /login:', err.message);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── Manejo de rutas no encontradas ─────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'Ruta no encontrada' });
});

// ── Arrancar servidor ──────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[auth] Auth service corriendo en puerto ${PORT}`);
});