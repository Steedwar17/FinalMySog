require('dotenv').config();
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const jwt = require('jsonwebtoken');
const url = require('url');

// ─── Validación de variables de entorno ───────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET;
const PORT = process.env.PORT || 5000;

if (!JWT_SECRET) {
  console.error('[ERROR] JWT_SECRET no está definido en .env');
  process.exit(1);
}

// ─── App y servidor HTTP ───────────────────────────────────────────────────────
const app = express();

// Health-check: útil para verificar que el coordinador está vivo
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    connectedPlayers: players.size,
    uptime: process.uptime(),
  });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

// ─── Estado en memoria ────────────────────────────────────────────────────────
// Map: userId (string) → { username, socket, connectedAt }
const players = new Map();

// ─── Broadcast ────────────────────────────────────────────────────────────────
function broadcastPlayers() {
  const list = Array.from(players.entries()).map(([userId, p]) => ({
    userId,
    username: p.username,
  }));

  const msg = JSON.stringify({ type: 'players_update', players: list });

  for (const { socket } of players.values()) {
    if (socket.readyState === socket.OPEN) {
      socket.send(msg);
    }
  }

  console.log(`[BROADCAST] ${list.length} jugador(es) conectado(s):`, list.map(p => p.username));
}

// ─── Upgrade HTTP → WebSocket (aquí se valida el token) ──────────────────────
// IMPORTANTE: la validación ocurre en 'upgrade', ANTES de que el socket se abra.
// Si se hiciera dentro de wss.on('connection'), el socket ya estaría abierto al
// rechazarlo, lo cual es una vulnerabilidad menor (el cliente alcanza a conectar).
server.on('upgrade', (req, socket, head) => {
  const { pathname, query } = url.parse(req.url, true);

  // Solo aceptar conexiones en /connect
  if (pathname !== '/connect') {
    console.log(`[UPGRADE] Ruta no permitida: ${pathname}`);
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  const token = query.token;

  if (!token) {
    // En lugar de HTTP 401, completamos upgrade y cerramos con código
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.close(4001, 'invalid token');
    });
    return;
  }

  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch (err) {
  // Crear un WebSocket temporal y cerrarlo con código 4001
  const ws = new WebSocket(null); // socket no válido
  ws.close(4001, 'invalid token');
  socket.destroy();
  return;
}

  // Token válido: completar el upgrade y pasar el payload
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, payload);
  });
});

// ─── Lógica de conexión WebSocket ─────────────────────────────────────────────
wss.on('connection', (ws, payload) => {
  const { userId, username } = payload;

  console.log(`[CONNECT] ${username} (${userId})`);

  // ── Manejo de doble pestaña ───────────────────────────────────────────────
  // Decisión de diseño: si el mismo userId ya está conectado, se CIERRA la
  // conexión anterior y se acepta la nueva.
  // Justificación: un usuario que abre una pestaña nueva quiere usar esa nueva
  // sesión. Mantener la vieja activa causaría que recibiera mensajes en un tab
  // que puede estar abandonado o bloqueado. Desconectar la anterior garantiza
  // que siempre hay exactamente una conexión por userId, simplifica el broadcast
  // y evita "fantasmas" en el mapa.
  if (players.has(userId)) {
    const existing = players.get(userId);
    console.log(`[DUPLICATE] ${username} ya estaba conectado. Cerrando sesión anterior.`);
    existing.socket.close(4001, 'Nueva sesión iniciada en otra pestaña');
    players.delete(userId);
  }

  // Registrar al jugador
  players.set(userId, { username, socket: ws, connectedAt: new Date().toISOString() });

  // Informar a todos (incluido el recién llegado)
  broadcastPlayers();

  // ── Desconexión ───────────────────────────────────────────────────────────
  ws.on('close', (code, reason) => {
    // Solo eliminar si este socket sigue siendo el registrado para ese userId
    // (evita borrar al nuevo si ya se hizo el reemplazo por doble pestaña)
    const current = players.get(userId);
    if (current && current.socket === ws) {
      players.delete(userId);
      console.log(`[DISCONNECT] ${username} (${userId}) - código: ${code}`);
      broadcastPlayers();
    }
  });

  // ── Errores de socket ─────────────────────────────────────────────────────
  ws.on('error', (err) => {
    console.error(`[WS ERROR] ${username}: ${err.message}`);
  });

  // El coordinador no espera mensajes del cliente en esta fase del proyecto,
  // pero los registramos por si acaso
  ws.on('message', (data) => {
    console.log(`[MSG] ${username}: ${data}`);
  });
});

// ─── Arrancar servidor ────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`[OK] Coordinador escuchando en puerto ${PORT}`);
  console.log(`     Health check: http://localhost:${PORT}/health`);
  console.log(`     WS endpoint:  ws://localhost:${PORT}/connect?token=<JWT>`);
});