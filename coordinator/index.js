require('dotenv').config();
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const jwt = require('jsonwebtoken');
const url = require('url');

// ─── Variables de entorno ─────────────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET;
const PORT = process.env.PORT || 5001;

if (!JWT_SECRET) {
  console.error('[ERROR] JWT_SECRET no está definido en .env');
  process.exit(1);
}

// ─── Constantes del mundo ─────────────────────────────────────────────────────
const WORLD_WIDTH   = 1200;
const WORLD_HEIGHT  = 800;
const PLAYER_RADIUS = 20;
const PLAYER_SPEED  = 200;  // px por segundo
const TICK_RATE     = 20;   // Hz
const TICK_MS       = 1000 / TICK_RATE;

// ─── App y servidor HTTP ───────────────────────────────────────────────────────
const app = express();

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    connectedPlayers: players.size,
    uptime: process.uptime(),
    tickRate: TICK_RATE,
  });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

// ─── Estado en memoria ────────────────────────────────────────────────────────
const players = new Map(); // userId → { username, socket, connectedAt, x, y, intent, extras }

// ─── Helpers ──────────────────────────────────────────────────────────────────
function snapshot() {
  return Array.from(players.entries()).map(([userId, p]) => ({
    userId,
    username: p.username,
    x: p.x,
    y: p.y,
    extras: p.extras,
  }));
}

function broadcast(msg) {
  const raw = JSON.stringify(msg);
  for (const { socket } of players.values()) {
    if (socket.readyState === socket.OPEN) socket.send(raw);
  }
}

function broadcastPlayers() {
  const list = Array.from(players.entries()).map(([userId, p]) => ({
    userId,
    username: p.username,
  }));
  broadcast({ type: 'players_update', players: list });
  console.log(`[PLAYERS] ${list.length} jugador(es):`, list.map(p => p.username));
}

// ─── Game Loop ────────────────────────────────────────────────────────────────
let lastTick = Date.now();

function tick() {
  const now = Date.now();
  const dt = (now - lastTick) / 1000;
  lastTick = now;

  for (const p of players.values()) {
    const ix = p.intent.x;
    const iy = p.intent.y;
    const mag = Math.hypot(ix, iy);
    if (mag > 0) {
      p.x += (ix / mag) * PLAYER_SPEED * dt;
      p.y += (iy / mag) * PLAYER_SPEED * dt;
    }
    p.x = Math.max(PLAYER_RADIUS, Math.min(WORLD_WIDTH  - PLAYER_RADIUS, p.x));
    p.y = Math.max(PLAYER_RADIUS, Math.min(WORLD_HEIGHT - PLAYER_RADIUS, p.y));
  }

  broadcast({ type: 'state', t: now, players: snapshot() });
}

setInterval(tick, TICK_MS);

// ─── Upgrade HTTP → WebSocket ─────────────────────────────────────────────────
server.on('upgrade', (req, socket, head) => {
  const { pathname, query } = url.parse(req.url, true);

  if (pathname !== '/connect') {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  const token = query.token;
  if (!token) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch (err) {
    console.log(`[UPGRADE] Token inválido: ${err.message}`);
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, payload);
  });
});

// ─── Conexión WebSocket ───────────────────────────────────────────────────────
wss.on('connection', (ws, payload) => {
  const { userId, username } = payload;
  console.log(`[CONNECT] ${username} (${userId})`);

  if (players.has(userId)) {
    const existing = players.get(userId);
    console.log(`[DUPLICATE] ${username} ya conectado. Cerrando sesión anterior.`);
    existing.socket.close(4001, 'Nueva sesión iniciada en otra pestaña');
    players.delete(userId);
  }

  const startX = PLAYER_RADIUS + Math.random() * (WORLD_WIDTH  - 2 * PLAYER_RADIUS);
  const startY = PLAYER_RADIUS + Math.random() * (WORLD_HEIGHT - 2 * PLAYER_RADIUS);

  players.set(userId, {
    username,
    socket: ws,
    connectedAt: new Date().toISOString(),
    x: startX,
    y: startY,
    intent: { x: 0, y: 0 },
    extras: {},
  });

  ws.send(JSON.stringify({
    type: 'welcome',
    you: { userId, username },
    world: {
      width:        WORLD_WIDTH,
      height:       WORLD_HEIGHT,
      playerRadius: PLAYER_RADIUS,
      tickRate:     TICK_RATE,
    },
  }));

  broadcastPlayers();

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) { return; }

    const p = players.get(userId);
    if (!p) return;

    if (msg.type === 'intent') {
      const dir = msg.intent && msg.intent.dir;
      if (!dir || typeof dir.x !== 'number' || typeof dir.y !== 'number') return;
      p.intent = { x: Math.sign(dir.x), y: Math.sign(dir.y) };
      return;
    }

    if (msg.type === 'extras_update') {
      if (!msg.extras || typeof msg.extras !== 'object' || Array.isArray(msg.extras)) return;
      if (JSON.stringify(msg.extras).length > 1024) return;
      p.extras = msg.extras;
      return;
    }
  });

  ws.on('close', (code) => {
    const current = players.get(userId);
    if (current && current.socket === ws) {
      players.delete(userId);
      console.log(`[DISCONNECT] ${username} (${userId}) - código: ${code}`);
      broadcastPlayers();
    }
  });

  ws.on('error', (err) => {
    console.error(`[WS ERROR] ${username}: ${err.message}`);
  });
});

// ─── Arrancar servidor ────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`[OK] Coordinador en puerto ${PORT}`);
  console.log(`     Health: http://localhost:${PORT}/health`);
  console.log(`     WS:     ws://localhost:${PORT}/connect?token=<JWT>`);
  console.log(`     Mundo:  ${WORLD_WIDTH}x${WORLD_HEIGHT} | Speed: ${PLAYER_SPEED}px/s | ${TICK_RATE}Hz`);
});