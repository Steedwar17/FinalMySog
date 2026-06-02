require('dotenv').config();
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const jwt = require('jsonwebtoken');
const url = require('url');

const JWT_SECRET = process.env.JWT_SECRET;
const PORT = process.env.PORT || 5001;
const COORDINATOR_ID = process.env.COORDINATOR_ID || process.env.INSTANCE_ID || `coordinator-${PORT}`;

if (!JWT_SECRET) {
  console.error('[ERROR] JWT_SECRET no esta definido en .env');
  process.exit(1);
}

const WORLD_WIDTH = 1200;
const WORLD_HEIGHT = 800;
const PLAYER_RADIUS = 20;
const PLAYER_SPEED = 200;
const TICK_RATE = Number(process.env.TICK_RATE || 120);
const TICK_MS = 1000 / TICK_RATE;

const BALL_RADIUS = 12;
const BALL_FRICTION = 0.992;
const BALL_MAX_SPEED = 760;
const BALL_MIN_SPEED = 8;
const WALL_BOUNCE = 0.78;
const GOAL_WIDTH = 18;
const GOAL_HEIGHT = 150;
const GOAL_LIMIT = 4;

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

const players = new Map();
const chatMessages = [];
let restartVote = null;

const match = {
  status: 'waiting',
  score: { red: 0, blue: 0 },
  winner: null,
  startedAt: null,
  finishedAt: null,
  teamSelectionLocked: false,
};

const ball = {
  x: WORLD_WIDTH / 2,
  y: WORLD_HEIGHT / 2,
  vx: 0,
  vy: 0,
  radius: BALL_RADIUS,
  color: '#f7f2d2',
};

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    coordinatorId: COORDINATOR_ID,
    connectedPlayers: players.size,
    uptime: process.uptime(),
    tickRate: TICK_RATE,
    matchStatus: match.status,
  });
});

function snapshot() {
  return Array.from(players.entries()).map(([userId, p]) => ({
    userId,
    username: p.username,
    x: p.x,
    y: p.y,
    extras: p.extras,
    ping: p.ping,
  }));
}

function matchSnapshot() {
  return {
    status: match.status,
    score: { ...match.score },
    winner: match.winner,
    startedAt: match.startedAt,
    finishedAt: match.finishedAt,
    teamSelectionLocked: match.teamSelectionLocked,
  };
}

function statePayload(now = Date.now()) {
  return {
    type: 'state',
    t: now,
    players: snapshot(),
    ball: {
      x: ball.x,
      y: ball.y,
      vx: ball.vx,
      vy: ball.vy,
      speed: Math.hypot(ball.vx, ball.vy),
      radius: ball.radius,
      color: ball.color,
    },
    score: { ...match.score },
    match: matchSnapshot(),
  };
}

function broadcast(msg) {
  const raw = JSON.stringify(msg);
  for (const { socket } of players.values()) {
    if (socket.readyState === socket.OPEN) socket.send(raw);
  }
}

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcastPlayers() {
  const list = Array.from(players.entries()).map(([userId, p]) => ({
    userId,
    username: p.username,
    extras: p.extras,
    ping: p.ping,
  }));
  broadcast({ type: 'players_update', players: list });
  console.log(`[PLAYERS] ${list.length} jugador(es):`, list.map(p => p.username));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function goalTop() {
  return WORLD_HEIGHT / 2 - GOAL_HEIGHT / 2;
}

function isPlaying() {
  return match.status === 'playing';
}

function resetBall() {
  ball.x = WORLD_WIDTH / 2;
  ball.y = WORLD_HEIGHT / 2;
  ball.vx = 0;
  ball.vy = 0;
}

function teamOf(player) {
  return player && player.extras ? player.extras.team : null;
}

function teamPlayers(team) {
  return Array.from(players.values()).filter(p => teamOf(p) === team);
}

function chooseSpawn(player, index) {
  const team = teamOf(player);
  const teammates = teamPlayers(team);
  const slot = Math.max(0, teammates.indexOf(player));
  const spacing = PLAYER_RADIUS * 2 + 18;
  const centerY = WORLD_HEIGHT / 2;
  const y = clamp(centerY + (slot - (teammates.length - 1) / 2) * spacing, PLAYER_RADIUS, WORLD_HEIGHT - PLAYER_RADIUS);

  if (team === 'red') return { x: WORLD_WIDTH * 0.28, y };
  if (team === 'blue') return { x: WORLD_WIDTH * 0.72, y };

  const angle = (index / Math.max(1, players.size)) * Math.PI * 2;
  return {
    x: WORLD_WIDTH / 2 + Math.cos(angle) * 90,
    y: WORLD_HEIGHT / 2 + Math.sin(angle) * 90,
  };
}

function positionPlayersForKickoff() {
  Array.from(players.values()).forEach((p, index) => {
    const spawn = chooseSpawn(p, index);
    p.x = clamp(spawn.x, PLAYER_RADIUS, WORLD_WIDTH - PLAYER_RADIUS);
    p.y = clamp(spawn.y, PLAYER_RADIUS, WORLD_HEIGHT - PLAYER_RADIUS);
    p.intent = { x: 0, y: 0 };
  });
  resolvePlayerCollisions(6);
}

function startMatch() {
  match.status = 'playing';
  match.score = { red: 0, blue: 0 };
  match.winner = null;
  match.startedAt = Date.now();
  match.finishedAt = null;
  match.teamSelectionLocked = true;
  restartVote = null;

  resetBall();
  positionPlayersForKickoff();
  broadcastPlayers();
  broadcast({
    type: 'match_event',
    event: 'start',
    message: 'Partido iniciado. Gana el primero que llegue a 4 goles.',
  });
}

function finishMatch(winner) {
  match.status = 'finished';
  match.winner = winner;
  match.finishedAt = Date.now();
  match.teamSelectionLocked = false;
  restartVote = null;
  resetBall();

  broadcast({
    type: 'match_event',
    event: 'final',
    winner,
    message: `Partido terminado. Ganador: ${winner === 'red' ? 'Rojos' : 'Azules'}.`,
  });
}

function registerGoal(team) {
  if (!isPlaying()) return;

  match.score[team] += 1;
  resetBall();
  positionPlayersForKickoff();

  broadcast({
    type: 'match_event',
    event: 'goal',
    team,
    score: { ...match.score },
    message: `Gol de ${team === 'red' ? 'Rojos' : 'Azules'} (${match.score.red}-${match.score.blue}).`,
  });

  if (match.score[team] >= GOAL_LIMIT) finishMatch(team);
}

function movePlayers(dt) {
  for (const p of players.values()) {
    const ix = p.intent.x;
    const iy = p.intent.y;
    const mag = Math.hypot(ix, iy);

    if (mag > 0) {
      p.x += (ix / mag) * PLAYER_SPEED * dt;
      p.y += (iy / mag) * PLAYER_SPEED * dt;
    }

    p.x = clamp(p.x, PLAYER_RADIUS, WORLD_WIDTH - PLAYER_RADIUS);
    p.y = clamp(p.y, PLAYER_RADIUS, WORLD_HEIGHT - PLAYER_RADIUS);
  }
}

function resolvePlayerCollisions(iterations = 2) {
  const list = Array.from(players.values());
  const minDistance = PLAYER_RADIUS * 2;

  for (let pass = 0; pass < iterations; pass += 1) {
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const a = list[i];
        const b = list[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let dist = Math.hypot(dx, dy);

        if (dist >= minDistance) continue;

        if (dist < 0.0001) {
          dx = 1;
          dy = 0;
          dist = 1;
        }

        const nx = dx / dist;
        const ny = dy / dist;
        const overlap = minDistance - dist;
        const push = overlap / 2 + 0.01;

        a.x = clamp(a.x - nx * push, PLAYER_RADIUS, WORLD_WIDTH - PLAYER_RADIUS);
        a.y = clamp(a.y - ny * push, PLAYER_RADIUS, WORLD_HEIGHT - PLAYER_RADIUS);
        b.x = clamp(b.x + nx * push, PLAYER_RADIUS, WORLD_WIDTH - PLAYER_RADIUS);
        b.y = clamp(b.y + ny * push, PLAYER_RADIUS, WORLD_HEIGHT - PLAYER_RADIUS);
      }
    }
  }
}

function moveBall(dt) {
  if (!isPlaying()) return;

  ball.x += ball.vx * dt;
  ball.y += ball.vy * dt;
  ball.vx *= BALL_FRICTION;
  ball.vy *= BALL_FRICTION;

  const speed = Math.hypot(ball.vx, ball.vy);
  if (speed > BALL_MAX_SPEED) {
    const scale = BALL_MAX_SPEED / speed;
    ball.vx *= scale;
    ball.vy *= scale;
  } else if (speed < BALL_MIN_SPEED) {
    ball.vx = 0;
    ball.vy = 0;
  }

  const top = goalTop();
  const insideGoalY = ball.y >= top && ball.y <= top + GOAL_HEIGHT;

  if (ball.x - ball.radius <= GOAL_WIDTH && insideGoalY) {
    registerGoal('blue');
    return;
  }
  if (ball.x + ball.radius >= WORLD_WIDTH - GOAL_WIDTH && insideGoalY) {
    registerGoal('red');
    return;
  }

  if (ball.x - ball.radius < 0) {
    ball.x = ball.radius;
    ball.vx = Math.abs(ball.vx) * WALL_BOUNCE;
  } else if (ball.x + ball.radius > WORLD_WIDTH) {
    ball.x = WORLD_WIDTH - ball.radius;
    ball.vx = -Math.abs(ball.vx) * WALL_BOUNCE;
  }

  if (ball.y - ball.radius < 0) {
    ball.y = ball.radius;
    ball.vy = Math.abs(ball.vy) * WALL_BOUNCE;
  } else if (ball.y + ball.radius > WORLD_HEIGHT) {
    ball.y = WORLD_HEIGHT - ball.radius;
    ball.vy = -Math.abs(ball.vy) * WALL_BOUNCE;
  }
}

function resolveBallPlayerCollisions() {
  if (!isPlaying()) return;

  const minDistance = PLAYER_RADIUS + ball.radius;

  for (const p of players.values()) {
    let dx = ball.x - p.x;
    let dy = ball.y - p.y;
    let dist = Math.hypot(dx, dy);

    if (dist >= minDistance) continue;

    if (dist < 0.0001) {
      dx = 1;
      dy = 0;
      dist = 1;
    }

    const nx = dx / dist;
    const ny = dy / dist;
    const overlap = minDistance - dist;
    ball.x = clamp(ball.x + nx * (overlap + 0.02), ball.radius, WORLD_WIDTH - ball.radius);
    ball.y = clamp(ball.y + ny * (overlap + 0.02), ball.radius, WORLD_HEIGHT - ball.radius);

    const intentMag = Math.hypot(p.intent.x, p.intent.y);
    const playerVx = intentMag > 0 ? (p.intent.x / intentMag) * PLAYER_SPEED : 0;
    const playerVy = intentMag > 0 ? (p.intent.y / intentMag) * PLAYER_SPEED : 0;
    const approach = Math.max(0, playerVx * nx + playerVy * ny);
    const bump = intentMag > 0 ? 240 + approach * 1.5 : 85;

    ball.vx = ball.vx * 0.42 + nx * bump + playerVx * 0.35;
    ball.vy = ball.vy * 0.42 + ny * bump + playerVy * 0.35;
  }
}

function tick() {
  const now = Date.now();
  const dt = Math.min(0.05, (now - lastTick) / 1000);
  lastTick = now;

  movePlayers(dt);
  resolvePlayerCollisions(3);
  moveBall(dt);
  resolveBallPlayerCollisions();

  broadcast(statePayload(now));
}

function teamPlayerCount() {
  let total = 0;
  for (const p of players.values()) {
    if (teamOf(p) === 'red' || teamOf(p) === 'blue') total += 1;
  }
  return total;
}

function restartVoters() {
  return Array.from(players.entries())
    .filter(([, p]) => teamOf(p) === 'red' || teamOf(p) === 'blue')
    .map(([userId]) => userId);
}

function cancelRestartVote(message = 'No se reinicio el partido.') {
  if (!restartVote) return;
  const voteId = restartVote.voteId;
  restartVote = null;
  broadcast({ type: 'restart_vote_rejected', voteId, message });
}

function handleRestartVoteRequest(userId, username) {
  if (!isPlaying()) return;

  const total = teamPlayerCount();
  if (total < 1) return;

  restartVote = {
    voteId: `${Date.now()}-${userId}`,
    requestedBy: username,
    accepted: new Set([userId]),
    voters: new Set(restartVoters()),
  };

  broadcast({
    type: 'restart_vote_request',
    voteId: restartVote.voteId,
    requestedBy: username,
    accepted: restartVote.accepted.size,
    total: restartVote.voters.size,
  });
}

function handleRestartVoteResponse(userId, accepted) {
  if (!restartVote || !restartVote.voters.has(userId)) return;
  if (!accepted) {
    cancelRestartVote('Un jugador rechazo el reinicio.');
    return;
  }

  restartVote.accepted.add(userId);

  if (restartVote.accepted.size >= restartVote.voters.size) {
    const voteId = restartVote.voteId;
    restartVote = null;
    broadcast({ type: 'restart_vote_approved', voteId, message: 'Todos aceptaron. Reiniciando partido...' });
    startMatch();
    return;
  }

  broadcast({
    type: 'restart_vote_update',
    voteId: restartVote.voteId,
    accepted: restartVote.accepted.size,
    total: restartVote.voters.size,
  });
}

function sanitizeExtras(extras) {
  const clean = {};
  if (extras.team === 'red' || extras.team === 'blue') clean.team = extras.team;
  if (typeof extras.color === 'string' && extras.color.length <= 40) clean.color = extras.color;
  return clean;
}

let lastTick = Date.now();
setInterval(tick, TICK_MS);

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
    console.log(`[UPGRADE] Token invalido: ${err.message}`);
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, payload);
  });
});

wss.on('connection', (ws, payload) => {
  const { userId, username } = payload;
  console.log(`[CONNECT] ${username} (${userId})`);

  if (players.has(userId)) {
    const existing = players.get(userId);
    console.log(`[DUPLICATE] ${username} ya conectado. Cerrando sesion anterior.`);
    existing.socket.close(4001, 'Nueva sesion iniciada en otra pestana');
    players.delete(userId);
  }

  const startX = PLAYER_RADIUS + Math.random() * (WORLD_WIDTH - 2 * PLAYER_RADIUS);
  const startY = PLAYER_RADIUS + Math.random() * (WORLD_HEIGHT - 2 * PLAYER_RADIUS);

  players.set(userId, {
    username,
    socket: ws,
    connectedAt: new Date().toISOString(),
    x: startX,
    y: startY,
    intent: { x: 0, y: 0 },
    extras: {},
    ping: null,
  });
  resolvePlayerCollisions(8);

  send(ws, {
    type: 'welcome',
    coordinatorId: COORDINATOR_ID,
    you: { userId, username },
    world: {
      width: WORLD_WIDTH,
      height: WORLD_HEIGHT,
      playerRadius: PLAYER_RADIUS,
      tickRate: TICK_RATE,
      ballRadius: BALL_RADIUS,
      goalWidth: GOAL_WIDTH,
      goalHeight: GOAL_HEIGHT,
      goalLimit: GOAL_LIMIT,
    },
  });
  send(ws, { type: 'chat_history', messages: chatMessages });
  send(ws, statePayload());

  broadcastPlayers();

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) { return; }

    const p = players.get(userId);
    if (!p) return;

    if (msg.type === 'ping') {
      send(ws, { type: 'pong', sentAt: msg.sentAt, serverAt: Date.now() });
      return;
    }

    if (msg.type === 'latency_update') {
      if (typeof msg.ping !== 'number' || !Number.isFinite(msg.ping)) return;
      p.ping = clamp(Math.round(msg.ping), 0, 9999);
      return;
    }

    if (msg.type === 'intent') {
      const dir = msg.intent && msg.intent.dir;
      if (!dir || typeof dir.x !== 'number' || typeof dir.y !== 'number') return;
      p.intent = { x: Math.sign(dir.x), y: Math.sign(dir.y) };
      return;
    }

    if (msg.type === 'extras_update') {
      if (!msg.extras || typeof msg.extras !== 'object' || Array.isArray(msg.extras)) return;
      if (JSON.stringify(msg.extras).length > 1024) return;
      if (match.teamSelectionLocked && msg.extras.team && msg.extras.team !== p.extras.team) return;
      p.extras = { ...p.extras, ...sanitizeExtras(msg.extras) };
      broadcastPlayers();
      return;
    }

    if (msg.type === 'start_match') {
      if (players.size < 2) {
        send(ws, { type: 'match_event', event: 'error', message: 'Se necesitan al menos 2 jugadores para jugar.' });
        return;
      }
      if (isPlaying()) return;
      startMatch();
      return;
    }

    if (msg.type === 'restart_vote_request') {
      handleRestartVoteRequest(userId, username);
      return;
    }

    if (msg.type === 'restart_vote_response') {
      handleRestartVoteResponse(userId, Boolean(msg.accepted));
      return;
    }

    if (msg.type === 'chat') {
      const text = String(msg.text || '').trim().slice(0, 160);
      if (!text) return;
      const message = { username, text, ts: Date.now() };
      chatMessages.push(message);
      if (chatMessages.length > 40) chatMessages.shift();
      broadcast({ type: 'chat_message', message });
    }
  });

  ws.on('close', (code) => {
    const current = players.get(userId);
    if (current && current.socket === ws) {
      players.delete(userId);
      if (restartVote && restartVote.voters.has(userId)) cancelRestartVote('Votacion cancelada por desconexion.');
      console.log(`[DISCONNECT] ${username} (${userId}) - codigo: ${code}`);
      broadcastPlayers();
    }
  });

  ws.on('error', (err) => {
    console.error(`[WS ERROR] ${username}: ${err.message}`);
  });
});

server.listen(PORT, () => {
  console.log(`[OK] Coordinador en puerto ${PORT}`);
  console.log(`     Health: http://localhost:${PORT}/health`);
  console.log(`     WS:     ws://localhost:${PORT}/connect?token=<JWT>`);
  console.log(`     Mundo:  ${WORLD_WIDTH}x${WORLD_HEIGHT} | Speed: ${PLAYER_SPEED}px/s | ${TICK_RATE}Hz`);
});
