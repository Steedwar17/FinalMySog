require('dotenv').config();

const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');
const Database = require('better-sqlite3');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');

// ── Configuración ──────────────────────────────────────────────────────────
const PORT           = parseInt(process.env.PORT || '4000', 10);
const PEER_PORT      = parseInt(process.env.PEER_PORT || '4100', 10);
const AUTH_ID        = process.env.AUTH_ID || 'auth-a';
const PUBLIC_URL     = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
const PEER_URL       = process.env.PEER_URL   || `ws://localhost:${PEER_PORT}`;
const PEER_URLS      = (process.env.PEER_URLS || '').split(',').map(u => u.trim()).filter(Boolean);
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

const allowedOrigins = (process.env.CORS_ORIGINS || '').split(',').map(o => o.trim());
const corsOptions = {
  origin: function(origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
  optionsSuccessStatus: 200
};

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
  );
  CREATE TABLE IF NOT EXISTS write_log (
    seq  INTEGER PRIMARY KEY AUTOINCREMENT,
    op   TEXT NOT NULL,
    data TEXT NOT NULL
  );
`);

const stmts = {
  insertLocal:    db.prepare("INSERT INTO users (username, provider, password_hash) VALUES (?, 'local', ?)"),
  insertGoogle:   db.prepare("INSERT INTO users (username, provider, google_sub, email) VALUES (?, 'google', ?, ?)"),
  findByUsername: db.prepare('SELECT * FROM users WHERE username = ?'),
  findByGoogle:   db.prepare('SELECT * FROM users WHERE google_sub = ?'),
  countUsers:     db.prepare('SELECT COUNT(*) as count FROM users'),
  logWrite:       db.prepare('INSERT INTO write_log (op, data) VALUES (?, ?)'),
  getLogFrom:     db.prepare('SELECT seq, op, data FROM write_log WHERE seq > ? ORDER BY seq ASC'),
  maxSeq:         db.prepare('SELECT MAX(seq) as maxSeq FROM write_log'),
};

// ── Estado de replicación ──────────────────────────────────────────────────
let role          = 'replica';   // 'leader' | 'replica'
let currentTerm   = 0;
let leaderUrl     = null;
let lastAppliedSeq = (() => { const r = stmts.maxSeq.get(); return r.maxSeq || 0; })();
let leaderLastSeq  = lastAppliedSeq;
let lastHeartbeat  = null;
let votesReceived  = 0;
let electionTimer  = null;

// Map de peers WS conectados: authId -> WebSocket
const peers = new Map();
// Info de peers conocidos: authId -> { publicUrl, peerUrl, role }
const peerInfo = new Map();

// ── Directory Service — coordinadores vivos ────────────────────────────────
const coordinators = new Map();
const HEARTBEAT_TIMEOUT = 6000;

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

function getLastSeq() {
  const r = stmts.maxSeq.get();
  return r.maxSeq || 0;
}

function broadcastToPeers(msg) {
  const str = JSON.stringify(msg);
  for (const ws of peers.values()) {
    if (ws.readyState === WebSocket.OPEN) ws.send(str);
  }
}

function applyWrite(op, data) {
  if (op === 'register') {
    try {
      stmts.insertLocal.run(data.username, data.password_hash);
    } catch(e) { /* ya existe, ignorar */ }
  } else if (op === 'register_google') {
    try {
      stmts.insertGoogle.run(data.username, data.google_sub, data.email);
    } catch(e) { /* ya existe, ignorar */ }
  }
}

// ── Elección de líder ──────────────────────────────────────────────────────
function startElection() {
  currentTerm++;
  role = 'replica';
  leaderUrl = null;
  votesReceived = 1; // voto por uno mismo
  console.log(`[auth] ${AUTH_ID} inicia elección — term ${currentTerm}`);

  broadcastToPeers({
    type: 'election',
    candidate: AUTH_ID,
    term: currentTerm,
    lastSeq: getLastSeq(),
  });

  // Si en 3 segundos no hay quórum, reintentar
  setTimeout(() => {
    if (role !== 'leader') {
      console.log(`[auth] Elección sin quórum, reintentando...`);
      startElection();
    }
  }, 3000);
}

function becomeLeader() {
  role = 'leader';
  leaderUrl = PUBLIC_URL;
  console.log(`[auth] ${AUTH_ID} es ahora el LÍDER — term ${currentTerm}`);

  broadcastToPeers({
    type: 'new_leader',
    leader: AUTH_ID,
    term: currentTerm,
    leaderUrl: PUBLIC_URL,
  });

  // Cancelar watchdog — el líder no necesita vigilarse a sí mismo
  if (leaderWatchdog) {
    clearTimeout(leaderWatchdog);
    leaderWatchdog = null;
  }

  if (electionTimer) clearInterval(electionTimer);
  electionTimer = setInterval(() => {
    if (role === 'leader') {
      broadcastToPeers({
        type: 'heartbeat',
        authId: AUTH_ID,
        term: currentTerm,
        lastSeq: getLastSeq(),
      });
    }
  }, 2000);
}

// Detectar muerte del líder
let leaderWatchdog = null;
function resetLeaderWatchdog() {
  lastHeartbeat = Date.now();
  if (leaderWatchdog) clearTimeout(leaderWatchdog);
  leaderWatchdog = setTimeout(() => {
    if (role !== 'leader') {
      console.log(`[auth] Líder no responde — iniciando elección`);
      startElection();
    }
  }, 6000);
}

// ── Manejo de mensajes del mesh ────────────────────────────────────────────
function handlePeerMessage(msg, ws) {
  if (msg.type === 'hello') {
    peerInfo.set(msg.authId, {
      authId: msg.authId,
      role: msg.role,
      term: msg.term,
    });
    // Si el que se conecta tiene term mayor, actualizar
    if (msg.term > currentTerm) {
      currentTerm = msg.term;
      role = 'replica';
    }
    // Pedir sync si estamos atrasados
    const mySeq = getLastSeq();
    if (msg.role === 'leader' && mySeq < (msg.lastSeq || 0)) {
      ws.send(JSON.stringify({ type: 'request_sync', fromSeq: mySeq }));
    }
    resetLeaderWatchdog();
  }

  else if (msg.type === 'heartbeat') {
    if (msg.term >= currentTerm) {
      currentTerm = msg.term;
      leaderLastSeq = msg.lastSeq || 0;
      resetLeaderWatchdog();
      // Pedir sync si estamos atrasados
      const mySeq = getLastSeq();
      if (leaderLastSeq - mySeq > 0) {
        ws.send(JSON.stringify({ type: 'request_sync', fromSeq: mySeq }));
      }
    }
  }

  else if (msg.type === 'write_propagate') {
    if (msg.term >= currentTerm && msg.seq > lastAppliedSeq) {
      applyWrite(msg.op, msg.data);
      stmts.logWrite.run(msg.op, JSON.stringify(msg.data));
      lastAppliedSeq = msg.seq;
      console.log(`[auth] Escritura aplicada seq=${msg.seq} op=${msg.op}`);
    }
  }

  else if (msg.type === 'request_sync') {
    if (role === 'leader') {
      const entries = stmts.getLogFrom.all(msg.fromSeq).map(e => ({
        seq: e.seq,
        op: e.op,
        data: JSON.parse(e.data),
      }));
      ws.send(JSON.stringify({ type: 'sync_response', entries }));
    }
  }

  else if (msg.type === 'sync_response') {
    for (const entry of msg.entries) {
      if (entry.seq > lastAppliedSeq) {
        applyWrite(entry.op, entry.data);
        stmts.logWrite.run(entry.op, JSON.stringify(entry.data));
        lastAppliedSeq = entry.seq;
      }
    }
    console.log(`[auth] Sync completado — lastSeq=${lastAppliedSeq}`);
  }

  else if (msg.type === 'election') {
    if (msg.term > currentTerm) {
      currentTerm = msg.term;
      role = 'replica';
      leaderUrl = null;
    }
    // Votar si el candidato está al día
    const mySeq = getLastSeq();
    const voteGranted = msg.term >= currentTerm && msg.lastSeq >= mySeq;
    ws.send(JSON.stringify({
      type: 'vote',
      voter: AUTH_ID,
      term: msg.term,
      voteGranted,
    }));
  }

  else if (msg.type === 'vote') {
    if (msg.term === currentTerm && msg.voteGranted) {
      votesReceived++;
      const majority = Math.floor((peers.size + 1) / 2) + 1;
      if (votesReceived >= majority && role !== 'leader') {
        becomeLeader();
      }
    }
  }

  else if (msg.type === 'new_leader') {
    if (msg.term >= currentTerm) {
      currentTerm = msg.term;
      role = 'replica';
      leaderUrl = msg.leaderUrl;
      console.log(`[auth] Nuevo líder: ${msg.leader} — term ${msg.term}`);
      resetLeaderWatchdog();
    }
  }
}

// ── Servidor WS para peers ─────────────────────────────────────────────────
// ── Servidor HTTP + WS para peers ─────────────────────────────────────────
const httpServer = http.createServer(app);
const peerServer = new WebSocketServer({ server: httpServer });
console.log(`[auth] Mesh WS compartiendo puerto ${PORT}`);

peerServer.on('connection', (ws) => {
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      handlePeerMessage(msg, ws);
      if (msg.authId && !peers.has(msg.authId)) {
        peers.set(msg.authId, ws);
      }
    } catch(e) {}
  });

  ws.on('close', () => {
    for (const [id, sock] of peers.entries()) {
      if (sock === ws) {
        peers.delete(id);
        console.log(`[auth] Peer desconectado: ${id}`);
        break;
      }
    }
  });

  // Handshake
  ws.send(JSON.stringify({
    type: 'hello',
    authId: AUTH_ID,
    role,
    term: currentTerm,
    lastSeq: getLastSeq(),
  }));
});

peerServer.on('connection', (ws) => {
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      handlePeerMessage(msg, ws);
      if (msg.authId && !peers.has(msg.authId)) {
        peers.set(msg.authId, ws);
      }
    } catch(e) {}
  });

  ws.on('close', () => {
    for (const [id, sock] of peers.entries()) {
      if (sock === ws) {
        peers.delete(id);
        console.log(`[auth] Peer desconectado: ${id}`);
        break;
      }
    }
  });

  // Handshake
  ws.send(JSON.stringify({
    type: 'hello',
    authId: AUTH_ID,
    role,
    term: currentTerm,
    lastSeq: getLastSeq(),
  }));
});

// ── Conectar a peers conocidos ─────────────────────────────────────────────
function connectToPeer(peerUrl) {
  console.log(`[auth] Conectando a peer: ${peerUrl}`);
  const ws = new WebSocket(peerUrl);

  ws.on('open', () => {
    ws.send(JSON.stringify({
      type: 'hello',
      authId: AUTH_ID,
      role,
      term: currentTerm,
      lastSeq: getLastSeq(),
    }));
  });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      handlePeerMessage(msg, ws);
      if (msg.authId && !peers.has(msg.authId)) {
        peers.set(msg.authId, ws);
      }
    } catch(e) {}
  });

  ws.on('close', () => {
    console.log(`[auth] Peer caído: ${peerUrl} — reintentando en 5s`);
    setTimeout(() => connectToPeer(peerUrl), 5000);
  });

  ws.on('error', () => {
    console.log(`[auth] Error conectando a ${peerUrl}`);
  });
}

// Conectar a peers al arrancar
setTimeout(() => {
  for (const url of PEER_URLS) {
    connectToPeer(url);
  }
  // Iniciar elección después de conectar
  setTimeout(() => {
    if (role !== 'leader') {
      if (peers.size === 0) {
        // Nadie conectado, me convierto en líder directamente
        console.log(`[auth] Sin peers — convirtiéndome en líder directamente`);
        becomeLeader();
      } else {
        startElection();
      }
    }
  }, 3000);
}, 1000);

// ── Express ────────────────────────────────────────────────────────────────
const app = express();
app.use(cors(corsOptions));
app.use(express.json({ limit: '4kb' }));
app.options('*', cors(corsOptions));

// ── GET /status ────────────────────────────────────────────────────────────
app.get('/status', (_req, res) => {
  res.json({
    authId: AUTH_ID,
    role,
    publicUrl: PUBLIC_URL,
    peerUrl: PEER_URL,
    leaderUrl: role === 'leader' ? PUBLIC_URL : leaderUrl,
    knownPeers: Array.from(peerInfo.keys()),
    lastAppliedSeq: getLastSeq(),
    users: stmts.countUsers.get().count,
  });
});

// ── GET /peers ─────────────────────────────────────────────────────────────
app.get('/peers', (_req, res) => {
  const authPeers = Array.from(peerInfo.values()).map(p => ({
    authId: p.authId,
    publicUrl: p.publicUrl || null,
    peerUrl: p.peerUrl || null,
    role: p.role,
  }));
  res.json({ peers: authPeers });
});

// ── Health check ───────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'auth-service', role, authId: AUTH_ID });
});

// ── Middleware para verificar si es líder en escrituras ────────────────────
function requireLeader(req, res, next) {
  if (role === 'leader') return next();
  if (!leaderUrl) {
    return res.status(503).json({ error: 'no_leader' });
  }
  return res.status(503).json({ error: 'not_leader', leaderUrl });
}

// ── POST /register ─────────────────────────────────────────────────────────
app.post('/register', requireLeader, async (req, res) => {
  const { username, password } = req.body ?? {};
  const usernameError = validateUsername(username);
  if (usernameError) return res.status(400).json({ error: usernameError });
  if (typeof password !== 'string' || password.length < 6) {
    return res.status(400).json({ error: 'password debe tener al menos 6 caracteres' });
  }
  try {
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const result = stmts.insertLocal.run(username.trim(), passwordHash);
    const userId = result.lastInsertRowid;

    // Guardar en log y propagar
    const data = { userId, username: username.trim(), provider: 'local', password_hash: passwordHash, created_at: new Date().toISOString() };
    const logResult = stmts.logWrite.run('register', JSON.stringify(data));
    const seq = logResult.lastInsertRowid;

    broadcastToPeers({ type: 'write_propagate', term: currentTerm, seq, op: 'register', data });

    console.log(`[auth] Registrado (local): ${username} id=${userId}`);
    return res.status(201).json({ userId, username: username.trim() });
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

  // Si soy replica muy atrasada, redirigir al líder
  if (role === 'replica' && leaderLastSeq - getLastSeq() > 10) {
    return res.status(503).json({ error: 'not_leader', leaderUrl });
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
    const ticket = await googleClient.verifyIdToken({ idToken, audience: GOOGLE_CLIENT_ID });
    payload = ticket.getPayload();
  } catch (err) {
    return res.status(401).json({ error: 'invalid_id_token' });
  }
  if (!payload.email_verified) {
    return res.status(401).json({ error: 'email_not_verified' });
  }
  const googleSub = payload.sub;
  const email = payload.email;
  const existing = stmts.findByGoogle.get(googleSub);

  // Usuario existente — lectura, cualquiera puede responder
  if (existing) {
    console.log(`[auth] Login (google): ${existing.username}`);
    return res.json({ token: emitToken(existing), username: existing.username });
  }

  // Usuario nuevo — escritura, solo el líder
  if (role !== 'leader') {
    if (!leaderUrl) return res.status(503).json({ error: 'no_leader' });
    return res.status(503).json({ error: 'not_leader', leaderUrl });
  }

  if (!username) {
    return res.status(409).json({ error: 'username_required', hint: 'Es tu primer ingreso con Google. Elige un username.' });
  }
  const usernameError = validateUsername(username);
  if (usernameError) return res.status(400).json({ error: usernameError });

  try {
    const result = stmts.insertGoogle.run(username.trim(), googleSub, email);
    const userId = result.lastInsertRowid;
    const data = { userId, username: username.trim(), provider: 'google', google_sub: googleSub, email, created_at: new Date().toISOString() };
    const logResult = stmts.logWrite.run('register_google', JSON.stringify(data));
    const seq = logResult.lastInsertRowid;

    broadcastToPeers({ type: 'write_propagate', term: currentTerm, seq, op: 'register_google', data });

    console.log(`[auth] Registrado (google): ${username} id=${userId}`);
    return res.json({ token: emitToken({ id: userId, username: username.trim(), provider: 'google' }), username: username.trim() });
  } catch (err) {
    if (err.message?.includes('UNIQUE constraint failed')) {
      return res.status(409).json({ error: 'username_taken' });
    }
    console.error('[auth] Error en /auth/google:', err.message);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── POST /heartbeat (coordinadores) ───────────────────────────────────────
app.post('/heartbeat', (req, res) => {
  const { coordinatorId, publicUrl, peerUrl, connectedPlayers, uptime } = req.body ?? {};
  if (!coordinatorId || !publicUrl || !peerUrl) {
    return res.status(400).json({ error: 'coordinatorId, publicUrl y peerUrl son requeridos' });
  }
  coordinators.set(coordinatorId, {
    coordinatorId, publicUrl, peerUrl,
    connectedPlayers: connectedPlayers ?? 0,
    uptime: uptime ?? 0,
    lastSeen: Date.now(),
  });
  console.log(`[auth] Heartbeat de ${coordinatorId} — jugadores: ${connectedPlayers}`);
  return res.json({ ok: true });
});

// ── GET /coordinator ───────────────────────────────────────────────────────
app.get('/coordinator', (_req, res) => {
  const vivos = Array.from(coordinators.values());
  if (vivos.length === 0) {
    return res.status(503).json({ error: 'no_coordinators_available' });
  }
  vivos.sort((a, b) => a.connectedPlayers - b.connectedPlayers);
  const elegido = vivos[0];
  console.log(`[auth] Cliente asignado a ${elegido.coordinatorId} (${elegido.connectedPlayers} jugadores)`);
  return res.json({ coordinatorId: elegido.coordinatorId, publicUrl: elegido.publicUrl });
});

// ── 404 ───────────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'Ruta no encontrada' });
});

// ── Arrancar ───────────────────────────────────────────────────────────────
httpServer.listen(PORT, () => {
  console.log(`[auth] ${AUTH_ID} corriendo en puerto ${PORT} — rol inicial: ${role}`);
  console.log(`[auth] CORS: ${process.env.CORS_ORIGINS}`);
});