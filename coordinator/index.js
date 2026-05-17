require('dotenv').config();
const express = require('express');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const jwt = require('jsonwebtoken');
const url = require('url');

// ─── Variables de entorno ─────────────────────────────────────────────────────
const JWT_SECRET     = process.env.JWT_SECRET;
const PORT           = process.env.PORT           || 5000;
const PEER_PORT      = process.env.PEER_PORT      || 5100;
const COORDINATOR_ID = process.env.COORDINATOR_ID || 'coord-a';
const PUBLIC_URL     = process.env.PUBLIC_URL     || `ws://localhost:${PORT}`;
const PEER_URL       = process.env.PEER_URL       || `ws://localhost:${PEER_PORT}`;
const AUTH_URL       = process.env.AUTH_URL       || 'http://localhost:4000';

if (!JWT_SECRET) {
  console.error('[ERROR] JWT_SECRET no está definido en .env');
  process.exit(1);
}

// ─── Constantes del mundo ─────────────────────────────────────────────────────
const WORLD_WIDTH   = 1200;
const WORLD_HEIGHT  = 800;
const PLAYER_RADIUS = 20;
const PLAYER_SPEED  = 200;
const TICK_RATE     = 20;
const TICK_MS       = 1000 / TICK_RATE;

// ─── Estado en memoria ────────────────────────────────────────────────────────
// local: true  → jugador conectado a ESTE coordinador (tiene socket)
// local: false → jugador remoto de otro coordinador (sin socket)
const players = new Map();

// Peers del mesh: Map<coordinatorId, WebSocket>
const peers = new Map();

// ─── App HTTP (clientes) ──────────────────────────────────────────────────────
const app = express();

app.get('/health', (req, res) => {
  const local = [...players.values()].filter(p => p.local).length;
  res.json({
    status: 'ok',
    coordinatorId: COORDINATOR_ID,
    localPlayers: local,
    totalPlayers: players.size,
    peers: [...peers.keys()],
    uptime: process.uptime(),
  });
});

const server = http.createServer(app);
const wss    = new WebSocketServer({ noServer: true });

// ─── Servidor de peers (puerto separado) ─────────────────────────────────────
const peerServer = http.createServer();
const peerWss    = new WebSocketServer({ server: peerServer });

// ─── Helpers ──────────────────────────────────────────────────────────────────
function snapshot() {
  return [...players.entries()].map(([userId, p]) => ({
    userId,
    username: p.username,
    x: p.x,
    y: p.y,
    extras: p.extras,
  }));
}

// Solo a clientes locales, NUNCA a peers
function broadcastClients(msg) {
  const raw = JSON.stringify(msg);
  for (const p of players.values()) {
    if (p.local && p.socket && p.socket.readyState === WebSocket.OPEN) {
      p.socket.send(raw);
    }
  }
}

function broadcastPlayers() {
  const list = [...players.entries()].map(([userId, p]) => ({
    userId, username: p.username,
  }));
  broadcastClients({ type: 'players_update', players: list });
}

// A todos los peers del mesh
function broadcastPeers(msg) {
  const raw = JSON.stringify(msg);
  for (const ws of peers.values()) {
    if (ws.readyState === WebSocket.OPEN) ws.send(raw);
  }
}

// ─── Game Loop a 20 Hz ───────────────────────────────────────────────────────
let lastTick = Date.now();

function tick() {
  const now = Date.now();
  const dt  = (now - lastTick) / 1000;
  lastTick  = now;

  for (const p of players.values()) {
    const ix  = p.intent.x;
    const iy  = p.intent.y;
    const mag = Math.hypot(ix, iy);
    if (mag > 0) {
      p.x += (ix / mag) * PLAYER_SPEED * dt;
      p.y += (iy / mag) * PLAYER_SPEED * dt;
    }
    p.x = Math.max(PLAYER_RADIUS, Math.min(WORLD_WIDTH  - PLAYER_RADIUS, p.x));
    p.y = Math.max(PLAYER_RADIUS, Math.min(WORLD_HEIGHT - PLAYER_RADIUS, p.y));
  }

  // State solo a clientes locales (incluye jugadores remotos en el snapshot)
  broadcastClients({ type: 'state', t: now, players: snapshot() });
}

setInterval(tick, TICK_MS);

// ─── Heartbeat al auth-service cada 2 segundos ───────────────────────────────
async function sendHeartbeat() {
  try {
    const localPlayers = [...players.values()].filter(p => p.local).length;
    await fetch(`${AUTH_URL}/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        coordinatorId:    COORDINATOR_ID,
        publicUrl:        PUBLIC_URL,
        peerUrl:          PEER_URL,
        connectedPlayers: localPlayers,
        uptime:           Math.floor(process.uptime()),
      }),
    });
  } catch (err) {
    console.warn(`[HEARTBEAT] falló: ${err.message}`);
  }
}

setInterval(sendHeartbeat, 2000);
sendHeartbeat();

// ─── Descubrimiento de peers ─────────────────────────────────────────────────
async function discoverPeers() {
  try {
    const res = await fetch(`${AUTH_URL}/peers`);
    if (!res.ok) return;
    const { peers: peerList } = await res.json();

    for (const peer of peerList) {
      if (peer.coordinatorId === COORDINATOR_ID) continue;
      if (peers.has(peer.coordinatorId)) continue;

      // Solo el de ID "menor" inicia la conexión → evita conexiones duplicadas
      if (COORDINATOR_ID < peer.coordinatorId) {
        connectToPeer(peer.coordinatorId, peer.peerUrl);
      }
    }
  } catch (err) {
    console.warn(`[PEERS] Error descubriendo: ${err.message}`);
  }
}

function connectToPeer(peerId, peerUrl) {
  console.log(`[PEER] Conectando a ${peerId} en ${peerUrl}`);
  const ws = new WebSocket(peerUrl);

  ws.on('open', () => {
    ws.send(JSON.stringify({ type: 'hello', coordinatorId: COORDINATOR_ID }));
    peers.set(peerId, ws);
    console.log(`[PEER] Conectado a ${peerId}`);

    // Sincronizar jugadores locales al nuevo peer
    for (const [userId, p] of players.entries()) {
      if (p.local) {
        ws.send(JSON.stringify({
          type: 'player_joined', origin: COORDINATOR_ID,
          userId, username: p.username, x: p.x, y: p.y,
        }));
      }
    }
  });

  ws.on('message', (raw) => handlePeerMessage(raw, peerId));

  ws.on('close', () => {
    peers.delete(peerId);
    removePeerPlayers(peerId);
    console.log(`[PEER] Desconectado: ${peerId}`);
  });

  ws.on('error', (err) => console.warn(`[PEER ERROR] ${peerId}: ${err.message}`));
}

function removePeerPlayers(peerId) {
  for (const [userId, p] of players.entries()) {
    if (!p.local && p.originCoord === peerId) {
      players.delete(userId);
    }
  }
  broadcastPlayers();
}

// ─── Manejo de mensajes entre peers ──────────────────────────────────────────
function handlePeerMessage(raw, fromPeerId) {
  let msg;
  try { msg = JSON.parse(raw.toString()); } catch (e) { return; }

  // Anti-bucle: descartar si el origen somos nosotros
  if (msg.origin === COORDINATOR_ID) return;

  switch (msg.type) {
    case 'hello':
      // Ya manejado en peerWss.on('connection')
      break;

    case 'player_joined': {
      const uid = String(msg.userId);
      if (!players.has(uid)) {
        players.set(uid, {
          username:    msg.username,
          socket:      null,
          local:       false,
          originCoord: msg.origin,
          x:           msg.x,
          y:           msg.y,
          intent:      { x: 0, y: 0 },
          extras:      {},
        });
        broadcastPlayers();
        console.log(`[REMOTE JOIN] ${msg.username} desde ${msg.origin}`);
      }
      break;
    }

    case 'player_left': {
      const uid = String(msg.userId);
      if (players.has(uid) && !players.get(uid).local) {
        players.delete(uid);
        broadcastPlayers();
        console.log(`[REMOTE LEAVE] userId ${msg.userId} desde ${msg.origin}`);
      }
      break;
    }

    case 'intent_replicate': {
      const p = players.get(String(msg.userId));
      if (p && msg.intent && msg.intent.dir) {
        p.intent = {
          x: Math.sign(msg.intent.dir.x),
          y: Math.sign(msg.intent.dir.y),
        };
      }
      break;
    }

    case 'extras_replicate': {
      const p = players.get(String(msg.userId));
      if (p && msg.extras && typeof msg.extras === 'object') {
        p.extras = msg.extras;
      }
      break;
    }
  }
}

// ─── Peer server: recibe conexiones entrantes de otros coordinadores ──────────
peerWss.on('connection', (ws) => {
  let peerId = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) { return; }

    if (msg.type === 'hello' && !peerId) {
      peerId = msg.coordinatorId;

      // Si ya tenemos conexión activa y nuestro ID es mayor, cerrar la nueva
      // (el de ID menor es quien inicia; el mayor espera recibirla)
      if (peers.has(peerId) && COORDINATOR_ID > peerId) {
        ws.close();
        return;
      }

      peers.set(peerId, ws);
      console.log(`[PEER] ${peerId} entró al mesh`);

      // Sincronizar jugadores locales al nuevo peer
      for (const [userId, p] of players.entries()) {
        if (p.local) {
          ws.send(JSON.stringify({
            type: 'player_joined', origin: COORDINATOR_ID,
            userId, username: p.username, x: p.x, y: p.y,
          }));
        }
      }
      return;
    }

    if (peerId) handlePeerMessage(raw, peerId);
  });

  ws.on('close', () => {
    if (peerId) {
      peers.delete(peerId);
      removePeerPlayers(peerId);
      console.log(`[PEER] ${peerId} salió del mesh`);
    }
  });

  ws.on('error', (err) => console.warn(`[PEER SERVER ERROR] ${err.message}`));
});

// ─── Upgrade HTTP → WebSocket de clientes ────────────────────────────────────
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
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, payload);
  });
});

// ─── Conexión de clientes ─────────────────────────────────────────────────────
wss.on('connection', (ws, payload) => {
  const userId   = String(payload.userId);
  const username = payload.username;
  console.log(`[CONNECT] ${username} (${userId})`);

  // Doble pestaña: cerrar sesión anterior
  if (players.has(userId) && players.get(userId).local) {
    players.get(userId).socket.close(4001, 'Nueva sesión en otra pestaña');
    players.delete(userId);
  }

  const startX = PLAYER_RADIUS + Math.random() * (WORLD_WIDTH  - 2 * PLAYER_RADIUS);
  const startY = PLAYER_RADIUS + Math.random() * (WORLD_HEIGHT - 2 * PLAYER_RADIUS);

  players.set(userId, {
    username,
    socket:      ws,
    local:       true,
    originCoord: COORDINATOR_ID,
    x:           startX,
    y:           startY,
    intent:      { x: 0, y: 0 },
    extras:      {},
  });

  // Bienvenida al cliente — incluye coordinatorId para mostrarlo en la UI
  ws.send(JSON.stringify({
    type:          'welcome',
    you:           { userId, username },
    coordinatorId: COORDINATOR_ID,
    world: {
      width:        WORLD_WIDTH,
      height:       WORLD_HEIGHT,
      playerRadius: PLAYER_RADIUS,
      tickRate:     TICK_RATE,
    },
  }));

  broadcastPlayers();

  // Notificar a peers que entró un jugador nuevo
  broadcastPeers({
    type:     'player_joined',
    origin:   COORDINATOR_ID,
    userId,
    username,
    x:        startX,
    y:        startY,
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) { return; }

    const p = players.get(userId);
    if (!p) return;

    if (msg.type === 'intent') {
      const dir = msg.intent && msg.intent.dir;
      if (!dir || typeof dir.x !== 'number' || typeof dir.y !== 'number') return;
      p.intent = { x: Math.sign(dir.x), y: Math.sign(dir.y) };

      // Replicar a peers
      broadcastPeers({
        type:   'intent_replicate',
        origin: COORDINATOR_ID,
        userId,
        intent: { dir: p.intent },
      });
      return;
    }

    if (msg.type === 'extras_update') {
      if (!msg.extras || typeof msg.extras !== 'object' || Array.isArray(msg.extras)) return;
      if (JSON.stringify(msg.extras).length > 1024) return;
      p.extras = msg.extras;

      // Replicar a peers
      broadcastPeers({
        type:   'extras_replicate',
        origin: COORDINATOR_ID,
        userId,
        extras: msg.extras,
      });
      return;
    }
  });

  ws.on('close', (code) => {
    const current = players.get(userId);
    if (current && current.socket === ws) {
      players.delete(userId);
      console.log(`[DISCONNECT] ${username} (${userId})`);
      broadcastPlayers();

      // Notificar a peers que se fue
      broadcastPeers({
        type:   'player_left',
        origin: COORDINATOR_ID,
        userId,
      });
    }
  });

  ws.on('error', (err) => console.error(`[WS ERROR] ${username}: ${err.message}`));
});

// ─── Arrancar ─────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`[OK] Coordinador "${COORDINATOR_ID}"`);
  console.log(`     Clientes: ws://localhost:${PORT}/connect?token=<JWT>`);
  console.log(`     Health:   http://localhost:${PORT}/health`);
});

peerServer.listen(PEER_PORT, () => {
  console.log(`     Peers:    ws://localhost:${PEER_PORT}`);
  setTimeout(discoverPeers, 1000);
  setInterval(discoverPeers, 5000);
});