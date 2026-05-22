require('dotenv').config();

const express    = require('express');
const cors       = require('cors');
const bcrypt     = require('bcrypt');
const jwt        = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');
const Database   = require('better-sqlite3');
const http       = require('http');
const { WebSocketServer, WebSocket } = require('ws');

// ── Configuración ──────────────────────────────────────────────────────────
const PORT           = parseInt(process.env.PORT  || '4000', 10);
const PEER_PORT      = parseInt(process.env.PEER_PORT || '4100', 10);
const AUTH_ID        = process.env.AUTH_ID   || 'auth-a';
const PUBLIC_URL     = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
const PEER_URL       = process.env.PEER_URL   || `ws://localhost:${PEER_PORT}`;
// Lista de peers: "auth-b=ws://localhost:4101,auth-c=ws://localhost:4102"
const PEER_LIST      = process.env.PEER_LIST  || '';

const JWT_SECRET     = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '1h';
const BCRYPT_ROUNDS  = parseInt(process.env.BCRYPT_ROUNDS || '10', 10);
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;

// Tolerancia de lag para lecturas en réplica (seq diff)
const REPLICA_LAG_TOLERANCE = parseInt(process.env.REPLICA_LAG_TOLERANCE || '10', 10);

const corsOptions = {
  origin: process.env.CORS_ORIGINS,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
  optionsSuccessStatus: 200,
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
const db = new Database(`users_${AUTH_ID}.db`);
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
  insertLocal:    db.prepare("INSERT INTO users (username, provider, password_hash, created_at) VALUES (?, 'local', ?, ?)"),
  insertGoogle:   db.prepare("INSERT INTO users (username, provider, google_sub, email, created_at) VALUES (?, 'google', ?, ?, ?)"),
  insertById:     db.prepare("INSERT OR IGNORE INTO users (id, username, provider, password_hash, google_sub, email, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"),
  findByUsername: db.prepare('SELECT * FROM users WHERE username = ?'),
  findByGoogle:   db.prepare('SELECT * FROM users WHERE google_sub = ?'),
  countUsers:     db.prepare('SELECT COUNT(*) as n FROM users'),
  logWrite:       db.prepare('INSERT INTO write_log (op, data) VALUES (?, ?)'),
  getLogFrom:     db.prepare('SELECT seq, op, data FROM write_log WHERE seq > ? ORDER BY seq ASC'),
  maxSeq:         db.prepare('SELECT MAX(seq) as s FROM write_log'),
};

function getMaxSeq() {
  const row = stmts.maxSeq.get();
  return row.s || 0;
}

// ── Estado del nodo ────────────────────────────────────────────────────────
let role          = 'replica';   // 'leader' | 'replica'
let currentTerm   = 0;
let currentLeaderUrl = null;     // URL pública del líder actual
let currentLeaderId  = null;
let lastAppliedSeq   = getMaxSeq();
let leaderLastSeq    = lastAppliedSeq; // lo que el líder reporta en heartbeat

// Timers
let heartbeatTimer    = null;   // usado por el líder para emitir HBs
let electionTimer     = null;   // usado por réplicas para detectar HB ausente
const HEARTBEAT_INTERVAL = 2000;
const ELECTION_TIMEOUT   = 6000;

// ── Mesh de peers ──────────────────────────────────────────────────────────
// Map<authId, { peerUrl, ws, role }>
const peers = new Map();

// Parsear PEER_LIST: "auth-b=ws://host:4101,auth-c=ws://host:4102"
if (PEER_LIST) {
  for (const entry of PEER_LIST.split(',')) {
    const [id, url] = entry.trim().split('=');
    if (id && url) peers.set(id, { peerUrl: url, ws: null, role: 'replica' });
  }
}

// ── Directory Service — coordinadores vivos (igual que antes) ──────────────
const coordinators = new Map();
const COORD_TIMEOUT = 6000;
setInterval(() => {
  const now = Date.now();
  for (const [id, info] of coordinators.entries()) {
    if (now - info.lastSeen > COORD_TIMEOUT) {
      coordinators.delete(id);
      console.log(`[${AUTH_ID}] Coordinador muerto eliminado: ${id}`);
    }
  }
}, 2000);

// ── Helpers JWT ────────────────────────────────────────────────────────────
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

// ── Aplicar una escritura recibida (desde propagación o sync) ──────────────
function applyWrite(op, data, seq) {
  try {
    const createdAt = data.created_at || new Date().toISOString();
    if (op === 'register') {
      stmts.insertById.run(data.userId, data.username, 'local', data.password_hash, null, null, createdAt);
    } else if (op === 'register_google') {
      stmts.insertById.run(data.userId, data.username, 'google', null, data.google_sub, data.email || null, createdAt);
    }
    lastAppliedSeq = seq;
  } catch (err) {
    console.error(`[${AUTH_ID}] applyWrite error (op=${op}):`, err.message);
  }
}

// ── Broadcast a todos los peers conectados ─────────────────────────────────
function broadcast(msg) {
  const raw = JSON.stringify(msg);
  for (const [id, p] of peers.entries()) {
    if (p.ws && p.ws.readyState === WebSocket.OPEN) {
      p.ws.send(raw);
    }
  }
}

// ── Heartbeat (líder → réplicas) ───────────────────────────────────────────
function startHeartbeats() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => {
    const msg = { type: 'heartbeat', authId: AUTH_ID, term: currentTerm, lastSeq: lastAppliedSeq };
    broadcast(msg);
  }, HEARTBEAT_INTERVAL);
}

function stopHeartbeats() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
}

// ── Election timeout (réplica → detecta líder muerto) ─────────────────────
function resetElectionTimer() {
  if (electionTimer) clearTimeout(electionTimer);
  electionTimer = setTimeout(() => {
    console.log(`[${AUTH_ID}] Timeout de heartbeat — iniciando elección`);
    startElection();
  }, ELECTION_TIMEOUT);
}

function stopElectionTimer() {
  if (electionTimer) { clearTimeout(electionTimer); electionTimer = null; }
}

// ── Elección ───────────────────────────────────────────────────────────────
let votesReceived = 0;
let votingFor     = null;

function startElection() {
  role = 'replica';
  currentTerm += 1;
  currentLeaderUrl = null;
  currentLeaderId  = null;
  votesReceived = 1; // me voto a mí mismo
  votingFor = AUTH_ID;

  console.log(`[${AUTH_ID}] Elección — term ${currentTerm}, lastSeq=${lastAppliedSeq}`);

  broadcast({
    type: 'election',
    candidate: AUTH_ID,
    term: currentTerm,
    lastSeq: lastAppliedSeq,
  });

  // Si no hay peers conectados, gano solo
  checkElectionWin();

  // Reiniciar el timer por si no hay quórum
  resetElectionTimer();
}

function checkElectionWin() {
  const totalNodes = 1 + peers.size; // yo + peers conocidos
  const majority = Math.floor(totalNodes / 2) + 1;
  if (votesReceived >= majority) {
    becomeLeader();
  }
}

function becomeLeader() {
  role = 'leader';
  currentLeaderUrl = PUBLIC_URL;
  currentLeaderId  = AUTH_ID;
  votesReceived = 0;
  votingFor = null;
  stopElectionTimer();
  startHeartbeats();

  console.log(`[${AUTH_ID}] 🎉 Soy el nuevo líder — term ${currentTerm}`);

  broadcast({ type: 'new_leader', leader: AUTH_ID, term: currentTerm, leaderUrl: PUBLIC_URL });
}

// ── Manejo de mensajes WS del mesh ─────────────────────────────────────────
function handlePeerMessage(senderId, raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }

  switch (msg.type) {

    case 'hello': {
      const p = peers.get(msg.authId);
      if (p) { p.role = msg.role; }
      // Si el remoto dice ser líder con term >= nuestro term, lo reconocemos
      if (msg.role === 'leader' && msg.term >= currentTerm) {
        currentTerm = msg.term;
        currentLeaderId = msg.authId;
        // Buscar publicUrl del líder
        const lp = peers.get(msg.authId);
        if (lp && lp.publicUrl) currentLeaderUrl = lp.publicUrl;
        if (role !== 'leader') resetElectionTimer();
      }
      // Si somos líder, enviarle sync si está atrasado
      if (role === 'leader' && msg.lastSeq !== undefined && msg.lastSeq < lastAppliedSeq) {
        sendSync(senderId, msg.lastSeq);
      }
      break;
    }

    case 'heartbeat': {
      if (msg.term < currentTerm) break; // heartbeat viejo, ignorar
      currentTerm      = msg.term;
      currentLeaderId  = msg.authId;
      leaderLastSeq    = msg.lastSeq;
      // Buscar publicUrl
      const lp = peers.get(msg.authId);
      if (lp && lp.publicUrl) currentLeaderUrl = lp.publicUrl;
      else currentLeaderUrl = null; // lo tendremos cuando el peer se registre
      resetElectionTimer();
      // Pedir sync si estamos atrasados
      if (msg.lastSeq > lastAppliedSeq) {
        const ws = peers.get(msg.authId)?.ws;
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'request_sync', fromSeq: lastAppliedSeq }));
        }
      }
      break;
    }

    case 'write_propagate': {
      if (msg.term < currentTerm) break;
      applyWrite(msg.op, msg.data, msg.seq);
      break;
    }

    case 'request_sync': {
      if (role !== 'leader') break;
      sendSync(senderId, msg.fromSeq);
      break;
    }

    case 'sync_response': {
      if (!msg.entries || !Array.isArray(msg.entries)) break;
      for (const entry of msg.entries) {
        if (entry.seq > lastAppliedSeq) {
          applyWrite(entry.op, entry.data, entry.seq);
        }
      }
      console.log(`[${AUTH_ID}] Sync completado — lastSeq=${lastAppliedSeq}`);
      break;
    }

    case 'election': {
      if (msg.term < currentTerm) {
        // Candidato obsoleto — no votar
        const ws = peers.get(msg.candidate)?.ws;
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'vote', voter: AUTH_ID, term: msg.term, voteGranted: false }));
        }
        break;
      }
      // Votar si no hemos votado en este term y el candidato está al día
      const canVote = (votingFor === null || votingFor === msg.candidate) &&
                      msg.term >= currentTerm &&
                      msg.lastSeq >= lastAppliedSeq;
      if (canVote) {
        currentTerm = msg.term;
        votingFor = msg.candidate;
        if (role === 'leader') {
          stopHeartbeats();
          role = 'replica';
        }
        resetElectionTimer();
        const ws = peers.get(msg.candidate)?.ws;
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'vote', voter: AUTH_ID, term: msg.term, voteGranted: true }));
        }
        console.log(`[${AUTH_ID}] Voté por ${msg.candidate} en term ${msg.term}`);
      } else {
        const ws = peers.get(msg.candidate)?.ws;
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'vote', voter: AUTH_ID, term: msg.term, voteGranted: false }));
        }
      }
      break;
    }

    case 'vote': {
      if (msg.term !== currentTerm) break;
      if (msg.voteGranted) {
        votesReceived += 1;
        console.log(`[${AUTH_ID}] Voto recibido de ${msg.voter} (${votesReceived} total)`);
        checkElectionWin();
      }
      break;
    }

    case 'new_leader': {
      if (msg.term < currentTerm) break;
      currentTerm = msg.term;
      currentLeaderId = msg.leader;
      currentLeaderUrl = msg.leaderUrl || null;
      votingFor = null;
      if (role === 'leader' && msg.leader !== AUTH_ID) {
        stopHeartbeats();
        role = 'replica';
      }
      stopElectionTimer();
      resetElectionTimer();
      console.log(`[${AUTH_ID}] Nuevo líder reconocido: ${msg.leader} (term ${msg.term})`);
      break;
    }

    case 'peer_info': {
      // Un peer nos informa su publicUrl
      const p = peers.get(msg.authId);
      if (p) {
        p.publicUrl = msg.publicUrl;
        if (currentLeaderId === msg.authId) currentLeaderUrl = msg.publicUrl;
      }
      break;
    }
  }
}

function sendSync(targetId, fromSeq) {
  const entries = stmts.getLogFrom.all(fromSeq).map(row => ({
    seq: row.seq,
    op: row.op,
    data: JSON.parse(row.data),
  }));
  const ws = peers.get(targetId)?.ws;
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'sync_response', entries }));
  }
}

// ── WS Server (puerto PEER_PORT) — escucha conexiones de otros auths ──────
const peerServer = new WebSocketServer({ port: PEER_PORT });
peerServer.on('listening', () => console.log(`[${AUTH_ID}] Peer WS escuchando en :${PEER_PORT}`));
peerServer.on('connection', (ws) => {
  let remoteId = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (!remoteId && msg.type === 'hello') {
      remoteId = msg.authId;
      // Registrar o actualizar peer
      if (!peers.has(remoteId)) {
        peers.set(remoteId, { peerUrl: null, ws, role: msg.role, publicUrl: msg.publicUrl || null });
      } else {
        const p = peers.get(remoteId);
        p.ws  = ws;
        p.role = msg.role;
        if (msg.publicUrl) p.publicUrl = msg.publicUrl;
      }
      console.log(`[${AUTH_ID}] Peer conectado (inbound): ${remoteId}`);
      // Responder con nuestro hello
      ws.send(JSON.stringify({
        type: 'hello',
        authId: AUTH_ID,
        role,
        term: currentTerm,
        lastSeq: lastAppliedSeq,
        publicUrl: PUBLIC_URL,
      }));
    }

    if (remoteId) handlePeerMessage(remoteId, raw);
  });

  ws.on('close', () => {
    if (remoteId) {
      console.log(`[${AUTH_ID}] Peer desconectado: ${remoteId}`);
      const p = peers.get(remoteId);
      if (p) p.ws = null;
    }
  });
});

// ── Conectar a peers outbound ──────────────────────────────────────────────
function connectToPeer(id, peerUrl) {
  // Solo el de AUTH_ID lexicográficamente menor inicia
  if (AUTH_ID >= id) return; // el de id mayor inicia; el menor espera

  function tryConnect() {
    console.log(`[${AUTH_ID}] Conectando a peer ${id} en ${peerUrl}…`);
    const ws = new WebSocket(peerUrl);

    ws.on('open', () => {
      const p = peers.get(id);
      if (p) p.ws = ws;
      // Handshake
      ws.send(JSON.stringify({
        type: 'hello',
        authId: AUTH_ID,
        role,
        term: currentTerm,
        lastSeq: lastAppliedSeq,
        publicUrl: PUBLIC_URL,
      }));
    });

    ws.on('message', (raw) => handlePeerMessage(id, raw));

    ws.on('close', () => {
      console.log(`[${AUTH_ID}] Conexión con ${id} cerrada — reintentando en 3s`);
      const p = peers.get(id);
      if (p) p.ws = null;
      setTimeout(tryConnect, 3000);
    });

    ws.on('error', (err) => {
      console.warn(`[${AUTH_ID}] Error conectando a ${id}: ${err.message}`);
    });
  }

  setTimeout(tryConnect, 1000 + Math.random() * 500);
}

// Iniciar conexiones outbound
for (const [id, p] of peers.entries()) {
  if (p.peerUrl) connectToPeer(id, p.peerUrl);
}

// ── Bootstrap: el primero en arrancar se autoproclama líder inicial ─────────
// Si no hay peers configurados en absoluto, soy líder solo.
// Si hay peers, espero HB; si no llega en ELECTION_TIMEOUT, inicio elección.
if (peers.size === 0) {
  // Nodo único — líder por defecto
  role = 'leader';
  currentLeaderUrl = PUBLIC_URL;
  currentLeaderId  = AUTH_ID;
  currentTerm      = 1;
  console.log(`[${AUTH_ID}] Nodo único — líder por defecto`);
  startHeartbeats();
} else {
  // Espera heartbeat; si no llega, inicia elección
  resetElectionTimer();
}

// ── Propagación de escritura ───────────────────────────────────────────────
// Opción A: aplica localmente, responde al cliente, propaga en background
function propagateWrite(op, data, seq) {
  const msg = { type: 'write_propagate', term: currentTerm, seq, op, data };
  broadcast(msg);
}

// ── Express ────────────────────────────────────────────────────────────────
const app = express();
app.use(cors(corsOptions));
app.use(express.json({ limit: '4kb' }));
app.options('*', cors(corsOptions));

// Middleware: adjunta estado actual
app.use((req, _res, next) => {
  req.authState = { role, currentLeaderUrl, currentTerm, lastAppliedSeq };
  next();
});

// ── Helpers de respuesta para réplica ──────────────────────────────────────
function rejectWrite(res) {
  if (!currentLeaderUrl) {
    return res.status(503).json({ error: 'no_leader' });
  }
  return res.status(503).json({ error: 'not_leader', leaderUrl: currentLeaderUrl });
}

function isReplicaLagged() {
  return (leaderLastSeq - lastAppliedSeq) > REPLICA_LAG_TOLERANCE;
}

// ── GET /health ────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'auth-service', authId: AUTH_ID });
});

// ── GET /status ────────────────────────────────────────────────────────────
app.get('/status', (_req, res) => {
  res.json({
    authId: AUTH_ID,
    role,
    publicUrl: PUBLIC_URL,
    peerUrl: PEER_URL,
    leaderUrl: currentLeaderUrl,
    knownPeers: Array.from(peers.keys()),
    lastAppliedSeq,
    users: stmts.countUsers.get().n,
    term: currentTerm,
  });
});

// ── GET /peers ─────────────────────────────────────────────────────────────
app.get('/peers', (_req, res) => {
  const list = Array.from(peers.entries()).map(([id, p]) => ({
    authId: id,
    publicUrl: p.publicUrl || null,
    peerUrl: p.peerUrl || null,
    role: p.role || 'unknown',
  }));
  res.json({ peers: list });
});

// ── POST /register ─────────────────────────────────────────────────────────
app.post('/register', async (req, res) => {
  if (role !== 'leader') return rejectWrite(res);

  const { username, password } = req.body ?? {};
  const usernameError = validateUsername(username);
  if (usernameError) return res.status(400).json({ error: usernameError });
  if (typeof password !== 'string' || password.length < 6) {
    return res.status(400).json({ error: 'password debe tener al menos 6 caracteres' });
  }
  try {
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const createdAt    = new Date().toISOString();
    const result = stmts.insertLocal.run(username.trim(), passwordHash, createdAt);
    const userId = result.lastInsertRowid;

    const data = { userId, username: username.trim(), provider: 'local', password_hash: passwordHash, created_at: createdAt };
    const logResult = stmts.logWrite.run('register', JSON.stringify(data));
    lastAppliedSeq = logResult.lastInsertRowid;
    propagateWrite('register', data, lastAppliedSeq);

    console.log(`[${AUTH_ID}] Registrado (local): ${username} id=${userId}`);
    return res.status(201).json({ userId, username: username.trim() });
  } catch (err) {
    if (err.message?.includes('UNIQUE constraint failed')) {
      return res.status(409).json({ error: 'El username ya esta registrado' });
    }
    console.error(`[${AUTH_ID}] Error en /register:`, err.message);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── POST /login ────────────────────────────────────────────────────────────
app.post('/login', async (req, res) => {
  // Lectura — réplica puede responder si no está muy atrasada
  if (role !== 'leader' && isReplicaLagged()) return rejectWrite(res);
  if (role !== 'leader' && !currentLeaderUrl) {
    return res.status(503).json({ error: 'no_leader' });
  }

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
    const match = await bcrypt.compare(password, user ? user.password_hash : dummyHash);
    if (!user || !match) {
      return res.status(401).json({ error: 'Credenciales invalidas' });
    }
    if (user.provider !== 'local') {
      return res.status(401).json({ error: 'Este usuario debe iniciar sesion con Google' });
    }
    console.log(`[${AUTH_ID}] Login (local): ${user.username}`);
    return res.status(200).json({ token: emitToken(user), username: user.username });
  } catch (err) {
    console.error(`[${AUTH_ID}] Error en /login:`, err.message);
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
  } catch {
    return res.status(401).json({ error: 'invalid_id_token' });
  }

  if (!payload.email_verified) {
    return res.status(401).json({ error: 'email_not_verified' });
  }

  const googleSub = payload.sub;
  const email     = payload.email;
  const existing  = stmts.findByGoogle.get(googleSub);

  if (existing) {
    // Lectura — réplica puede responder si no está atrasada
    if (role !== 'leader' && isReplicaLagged()) return rejectWrite(res);
    console.log(`[${AUTH_ID}] Login (google): ${existing.username}`);
    return res.json({ token: emitToken(existing), username: existing.username });
  }

  // Escritura — solo el líder
  if (role !== 'leader') return rejectWrite(res);

  if (!username) {
    return res.status(409).json({ error: 'username_required', hint: 'Es tu primer ingreso con Google. Elige un username.' });
  }
  const usernameError = validateUsername(username);
  if (usernameError) return res.status(400).json({ error: usernameError });

  try {
    const createdAt = new Date().toISOString();
    const result = stmts.insertGoogle.run(username.trim(), googleSub, email, createdAt);
    const userId = result.lastInsertRowid;
    const newUser = { id: userId, username: username.trim(), provider: 'google' };

    const data = { userId, username: username.trim(), provider: 'google', google_sub: googleSub, email, created_at: createdAt };
    const logResult = stmts.logWrite.run('register_google', JSON.stringify(data));
    lastAppliedSeq = logResult.lastInsertRowid;
    propagateWrite('register_google', data, lastAppliedSeq);

    console.log(`[${AUTH_ID}] Registrado (google): ${username} id=${userId}`);
    return res.json({ token: emitToken(newUser), username: newUser.username });
  } catch (err) {
    if (err.message?.includes('UNIQUE constraint failed')) {
      return res.status(409).json({ error: 'username_taken' });
    }
    console.error(`[${AUTH_ID}] Error en /auth/google:`, err.message);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── POST /heartbeat (coordinadores → directorio) ───────────────────────────
app.post('/heartbeat', (req, res) => {
  if (role !== 'leader') return rejectWrite(res);

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
  console.log(`[${AUTH_ID}] Heartbeat de ${coordinatorId} — jugadores: ${connectedPlayers}`);
  return res.json({ ok: true });
});

// ── GET /coordinator ───────────────────────────────────────────────────────
app.get('/coordinator', (req, res) => {
  // Réplica puede responder lecturas si no está muy atrasada
  if (role !== 'leader' && isReplicaLagged()) return rejectWrite(res);

  const vivos = Array.from(coordinators.values());
  if (vivos.length === 0) {
    return res.status(503).json({ error: 'no_coordinators_available' });
  }
  vivos.sort((a, b) => a.connectedPlayers - b.connectedPlayers);
  const elegido = vivos[0];
  console.log(`[${AUTH_ID}] Cliente asignado a ${elegido.coordinatorId} (${elegido.connectedPlayers} jugadores)`);
  return res.json({ coordinatorId: elegido.coordinatorId, publicUrl: elegido.publicUrl });
});

// ── GET /coordinator/all (réplicas también pueden servir) ──────────────────
app.get('/coordinator/all', (_req, res) => {
  const vivos = Array.from(coordinators.values());
  return res.json({ coordinators: vivos });
});

// ── 404 ───────────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'Ruta no encontrada' });
});

// ── Arrancar ───────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[${AUTH_ID}] Auth service en puerto ${PORT} | Peer WS: ${PEER_PORT}`);
  console.log(`[${AUTH_ID}] PUBLIC_URL=${PUBLIC_URL} | PEER_URL=${PEER_URL}`);
  console.log(`[${AUTH_ID}] Peers configurados: ${Array.from(peers.keys()).join(', ') || 'ninguno'}`);
});