require('dotenv').config();
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const { WebSocket } = require('ws');
const jwt = require('jsonwebtoken');
const url = require('url');

// --- Variables de entorno ---
const JWT_SECRET = process.env.JWT_SECRET;
const PORT = parseInt(process.env.PORT || '5001', 10);
const COORDINATOR_ID = process.env.COORDINATOR_ID || `coord-${PORT}`;
const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://localhost:4000';
const PUBLIC_WS_URL = process.env.PUBLIC_WS_URL || `ws://localhost:${PORT}`;

// Constantes del juego
const WORLD_WIDTH = 1200;
const WORLD_HEIGHT = 800;
const PLAYER_RADIUS = 20;
const PLAYER_SPEED = 200;
const TICK_RATE = Number(process.env.TICK_RATE || 120);
const TICK_MS = 1000 / TICK_RATE;

if (!JWT_SECRET || JWT_SECRET.length < 32) {
    console.error('[ERROR] JWT_SECRET no definida o menor a 32 caracteres');
    process.exit(1);
}

// --- Servidor HTTP unificado ---
const app = express();
app.get('/health', (req, res) => {
    res.json({ status: 'ok', connectedPlayers: players.size, coordinatorId: COORDINATOR_ID });
});
const server = http.createServer(app);

// --- WebSocket Server maestro (sin HTTP server propio) ---
const wss = new WebSocketServer({ noServer: true });

// --- Estado global del juego ---
const players = new Map(); // userId -> { username, socket, x, y, intent, extras, ping }
const peerConnections = new Map(); // peerId -> WebSocket

// --- Funciones de red ---
function broadcastToClients(message) {
    const data = JSON.stringify(message);
    for (const player of players.values()) {
        if (player.socket && player.socket.readyState === player.socket.OPEN) {
            player.socket.send(data);
        }
    }
}

function broadcastToPeers(message, excludePeerId = null) {
    const data = JSON.stringify(message);
    for (const [peerId, peerSocket] of peerConnections.entries()) {
        if (peerId === excludePeerId) continue;
        if (peerSocket.readyState === peerSocket.OPEN) {
            peerSocket.send(data);
        }
    }
}

function broadcastPlayersUpdate() {
    const playerList = Array.from(players.entries()).map(([id, p]) => ({
        userId: id,
        username: p.username,
        extras: p.extras,
        ping: p.ping,
    }));
    broadcastToClients({ type: 'players_update', players: playerList });
    console.log(`[BROADCAST] ${playerList.length} jugadores`);
}

// --- Game Loop ---
let lastTick = Date.now();
function gameLoop() {
    const now = Date.now();
    const dt = (now - lastTick) / 1000;
    lastTick = now;

    for (const player of players.values()) {
        const intent = player.intent;
        if (intent.x !== 0 || intent.y !== 0) {
            player.x += intent.x * PLAYER_SPEED * dt;
            player.y += intent.y * PLAYER_SPEED * dt;
            player.x = Math.max(PLAYER_RADIUS, Math.min(WORLD_WIDTH - PLAYER_RADIUS, player.x));
            player.y = Math.max(PLAYER_RADIUS, Math.min(WORLD_HEIGHT - PLAYER_RADIUS, player.y));
        }
    }

    const snapshot = Array.from(players.entries()).map(([id, p]) => ({
        userId: id,
        username: p.username,
        x: p.x,
        y: p.y,
        extras: p.extras,
        ping: p.ping,
    }));
    broadcastToClients({ type: 'state', t: now, players: snapshot });
}
setInterval(gameLoop, TICK_MS);

// --- Heartbeat (cada 2s) ---
setInterval(async () => {
    try {
        await fetch(`${AUTH_SERVICE_URL}/heartbeat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                coordinatorId: COORDINATOR_ID,
                publicUrl: PUBLIC_WS_URL,
                peerUrl: `${PUBLIC_WS_URL}/peer`,
                connectedPlayers: Array.from(players.values()).filter(p => p.socket).length,
                uptime: process.uptime(),
            }),
        });
    } catch (err) {
        console.error('[HEARTBEAT] Falló:', err.message);
    }
}, 2000);

// --- Descubrimiento de peers (cada 10s) ---
async function discoverPeers() {
    try {
        const response = await fetch(`${AUTH_SERVICE_URL}/peers`);
        if (!response.ok) return;
        const { peers: peerList } = await response.json();

        for (const peer of peerList) {
            if (peer.coordinatorId === COORDINATOR_ID) continue;
            if (peerConnections.has(peer.coordinatorId)) continue;

            const peerUrl = new URL(peer.peerUrl);
            peerUrl.pathname = '/peer';

            if (COORDINATOR_ID.localeCompare(peer.coordinatorId) < 0) {
                console.log(`[PEER] Conectando a ${peer.coordinatorId} en ${peerUrl.toString()}`);
                connectToPeer(peer.coordinatorId, peerUrl.toString());
            }
        }
    } catch (err) {
        console.error('[PEER DISCOVERY] Falló:', err.message);
    }
}

function connectToPeer(peerId, peerUrl) {
    const ws = new WebSocket(peerUrl);
    ws.on('open', () => {
        console.log(`[PEER] Conectado a ${peerId}`);
        ws.send(JSON.stringify({ type: 'hello', coordinatorId: COORDINATOR_ID }));
        peerConnections.set(peerId, ws);
    });
    ws.on('message', (data) => handlePeerMessage(peerId, data));
    ws.on('close', () => {
        console.log(`[PEER] Desconectado de ${peerId}`);
        peerConnections.delete(peerId);
    });
    ws.on('error', (err) => console.error(`[PEER ERROR] ${peerId}:`, err.message));
}

function handlePeerMessage(peerId, data) {
    let message;
    try { message = JSON.parse(data.toString()); } catch { return; }
    if (message.origin === COORDINATOR_ID) return;

    switch (message.type) {
        case 'hello':
            if (!peerConnections.has(message.coordinatorId) && message.coordinatorId !== COORDINATOR_ID) {
                peerConnections.set(message.coordinatorId, peerConnections.get(peerId));
            }
            break;
        case 'intent_replicate':
            const player = players.get(message.userId);
            if (player) player.intent = message.intent.dir;
            break;
        case 'extras_replicate':
            const targetPlayer = players.get(message.userId);
            if (targetPlayer) targetPlayer.extras = { ...targetPlayer.extras, ...message.extras };
            break;
        case 'player_joined':
            if (!players.has(message.userId)) {
                players.set(message.userId, {
                    username: message.username,
                    socket: null,
                    x: message.x,
                    y: message.y,
                    intent: { x: 0, y: 0 },
                    extras: message.extras || {},
                    ping: null,
                });
                broadcastPlayersUpdate();
            }
            break;
        case 'player_left':
            if (players.has(message.userId)) {
                players.delete(message.userId);
                broadcastPlayersUpdate();
            }
            break;
    }
}
setInterval(discoverPeers, 10000);
setTimeout(discoverPeers, 1000);

// --- Manejo de upgrades (con selección de ruta) ---
server.on('upgrade', (request, socket, head) => {
    const { pathname, query } = url.parse(request.url, true);
    console.log(`[UPGRADE] ${pathname} desde ${request.socket.remoteAddress}`);

    if (pathname === '/connect') {
        // Conexión de clientes: verificar token JWT
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

        wss.handleUpgrade(request, socket, head, (ws) => {
            wss.emit('connection', ws, payload);
        });
    } 
    else if (pathname === '/peer') {
        // Conexión de peers: aceptar sin verificación adicional
        wss.handleUpgrade(request, socket, head, (ws) => {
            wss.emit('peerConnection', ws);
        });
    } 
    else {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
    }
});

// --- Eventos para clientes (/connect) ---
wss.on('connection', (ws, payload) => {
    const { userId, username } = payload;
    console.log(`[CONNECT] ${username} (${userId})`);

    if (players.has(userId) && players.get(userId).socket) {
        const existing = players.get(userId);
        existing.socket.close(4001, 'Nueva sesión en otra pestaña');
    }

    const startX = PLAYER_RADIUS + Math.random() * (WORLD_WIDTH - 2 * PLAYER_RADIUS);
    const startY = PLAYER_RADIUS + Math.random() * (WORLD_HEIGHT - 2 * PLAYER_RADIUS);

    players.set(userId, {
        username,
        socket: ws,
        x: startX,
        y: startY,
        intent: { x: 0, y: 0 },
        extras: {},
        ping: null,
    });

    ws.send(JSON.stringify({
        type: 'welcome',
        you: { userId, username },
        world: { width: WORLD_WIDTH, height: WORLD_HEIGHT, playerRadius: PLAYER_RADIUS, tickRate: TICK_RATE },
    }));

    const joinMessage = {
        type: 'player_joined',
        origin: COORDINATOR_ID,
        userId,
        username,
        x: startX,
        y: startY,
        extras: {},
    };
    broadcastToPeers(joinMessage);
    broadcastPlayersUpdate();

    ws.on('message', (raw) => {
        let message;
        try { message = JSON.parse(raw.toString()); } catch { return; }
        const player = players.get(userId);
        if (!player) return;

        if (message.type === 'ping') {
            ws.send(JSON.stringify({ type: 'pong', sentAt: message.sentAt }));
            return;
        }
        if (message.type === 'latency_update') {
            if (typeof message.ping === 'number') player.ping = message.ping;
            return;
        }
        if (message.type === 'intent') {
            if (message.intent && message.intent.dir) {
                player.intent = message.intent.dir;
                broadcastToPeers({
                    type: 'intent_replicate',
                    origin: COORDINATOR_ID,
                    userId,
                    intent: { dir: player.intent },
                });
            }
            return;
        }
        if (message.type === 'extras_update') {
            if (message.extras) {
                player.extras = { ...player.extras, ...message.extras };
                broadcastToPeers({
                    type: 'extras_replicate',
                    origin: COORDINATOR_ID,
                    userId,
                    extras: message.extras,
                });
                broadcastPlayersUpdate();
            }
            return;
        }
    });

    ws.on('close', (code) => {
        const current = players.get(userId);
        if (current && current.socket === ws) {
            players.delete(userId);
            console.log(`[DISCONNECT] ${username} (${userId}) código: ${code}`);
            broadcastToPeers({ type: 'player_left', origin: COORDINATOR_ID, userId });
            broadcastPlayersUpdate();
        }
    });
});

// --- Eventos para peers (/peer) ---
wss.on('peerConnection', (ws) => {
    let peerId = null;
    console.log('[PEER] Nueva conexión entrante');

    ws.on('message', (data) => {
        let message;
        try { message = JSON.parse(data.toString()); } catch { return; }
        if (message.type === 'hello') {
            peerId = message.coordinatorId;
            if (peerId && peerId !== COORDINATOR_ID && !peerConnections.has(peerId)) {
                peerConnections.set(peerId, ws);
                console.log(`[PEER] Conexión entrante establecida con ${peerId}`);
            }
            return;
        }
        if (peerId) handlePeerMessage(peerId, data);
    });

    ws.on('close', () => {
        if (peerId) {
            console.log(`[PEER] Desconexión de ${peerId}`);
            peerConnections.delete(peerId);
        }
    });
});

// --- Iniciar servidor ---
server.listen(PORT, () => {
    console.log(`[OK] Coordinador ${COORDINATOR_ID} corriendo en puerto ${PORT}`);
    console.log(`     URL Pública: ${PUBLIC_WS_URL}`);
    console.log(`     Endpoint clientes: ${PUBLIC_WS_URL}/connect?token=<JWT>`);
    console.log(`     Endpoint peers: ${PUBLIC_WS_URL}/peer`);
});