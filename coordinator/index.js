require('dotenv').config();
const express = require('express');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const jwt = require('jsonwebtoken');
const url = require('url');

const JWT_SECRET     = process.env.JWT_SECRET;
const PORT           = process.env.PORT           || 5000;
const COORDINATOR_ID = process.env.COORDINATOR_ID || 'coord-a';
const PUBLIC_URL     = process.env.PUBLIC_URL     || `ws://localhost:${PORT}`;
const PEER_URL       = process.env.PEER_URL       || `ws://localhost:${PORT}/peer`;

const AUTH_URLS = process.env.AUTH_URLS
  ? process.env.AUTH_URLS.split(',').map(u => u.trim())
  : ['http://localhost:4000'];

let currentLeaderUrl = AUTH_URLS[0];

if (!JWT_SECRET) { console.error('[ERROR] JWT_SECRET no definido'); process.exit(1); }

// ─── Constantes ───────────────────────────────────────────────────────────────
const WORLD_WIDTH        = 1200;
const WORLD_HEIGHT       = 800;
const PLAYER_RADIUS      = 20;
const PLAYER_SPEED       = 60;
const BALL_RADIUS        = 12;
const BALL_FRICTION      = 0.985;
const BALL_MIN_SPEED     = 400;   
const GOAL_WIDTH         = 160;
const TEAM_SELECTION_SEC = 10;
const HALF_DURATION_SEC  = 90;
const HALFTIME_SEC       = 15;
const TICK_RATE          = parseInt(process.env.TICK_RATE || '60', 10);
const TICK_MS            = 1000 / TICK_RATE;
const MAX_CHAT_MSGS      = 40;
const MAX_CHAT_LEN       = 200;
const CHAT_RATE_MS       = 1000;
const GOAL_HP_PENALTY    = 30;
const WIN_SCORE = 4;

// Posiciones de spawn por equipo
const SPAWN = {
  red:  { x: WORLD_WIDTH * 0.25, y: WORLD_HEIGHT / 2 },
  blue: { x: WORLD_WIDTH * 0.75, y: WORLD_HEIGHT / 2 },
  none: { x: WORLD_WIDTH / 2,    y: WORLD_HEIGHT / 2 },
};

// ─── Estado en memoria ────────────────────────────────────────────────────────
const players     = new Map();
const spectators  = new Set();
const peers       = new Map();
const chatHistory = [];
const chatLastMsg = new Map();

const ball = { x: WORLD_WIDTH/2, y: WORLD_HEIGHT/2, vx: 0, vy: 0 };
const score = { red: 0, blue: 0 };
let restartVote = null;

// Estado del partido
const match = {
  status: 'waiting',
  half: 1,
  timeLeft: 0,
  teamSelectionLocked: false,
  winner: null,
};

// ─── App HTTP ─────────────────────────────────────────────────────────────────
const app = express();

app.get('/peers', (req, res) => {
  res.json({ coordinatorId: COORDINATOR_ID, peerUrl: PEER_URL, peers: [...peers.keys()].map(id => ({ coordinatorId: id })) });
});

app.get('/health', (req, res) => {
  const local = [...players.values()].filter(p => p.local).length;
  res.json({ status: 'ok', coordinatorId: COORDINATOR_ID, localPlayers: local, spectators: spectators.size, totalPlayers: players.size, peers: [...peers.keys()], score, match, uptime: process.uptime() });
});

const server  = http.createServer(app);
const wss     = new WebSocketServer({ noServer: true });
const specWss = new WebSocketServer({ noServer: true });
const peerWss = new WebSocketServer({ noServer: true });

// ─── Helpers broadcast ────────────────────────────────────────────────────────
function snapshot() {
  return [...players.entries()].map(([userId, p]) => ({
    userId, username: p.username,
    x: p.x, y: p.y,
    extras: { ...p.extras },
    ping: p.ping || null,
  }));
}
function getActivePlayers() {
  return [...players.entries()]
    .filter(([_, p]) =>
      p.extras.team &&
      !p.extras.eliminated
    );
}

function hasRestartTeam(p) {
  return p && ['red', 'blue'].includes(p.extras?.team);
}

function isConnectedPlayer(p) {
  if (!p) return false;
  if (!p.local) return true;
  return p.socket && p.socket.readyState === WebSocket.OPEN;
}

function getRestartPlayers() {
  return [...players.entries()]
    .filter(([_, p]) => hasRestartTeam(p) && isConnectedPlayer(p));
}

function fullState() {
  return {
    type: 'state', t: Date.now(),
    players: snapshot(),
    ball: { x: ball.x, y: ball.y, vx: ball.vx, vy: ball.vy, radius: BALL_RADIUS },
    score: { ...score },
    match: {
      status:              match.status,
      half:                match.half,
      timeLeft:            match.timeLeft,
      teamSelectionLocked: match.teamSelectionLocked,
      winner:              match.winner,
    },
    zones: [], items: [],
  };
}

function logStateForUser(reason, userId, state) {
  const player = userId
    ? state.players.find(entry => entry.userId === userId)
    : null;
  const team = player?.extras?.team ?? null;

  console.log(
    `[STATE DEBUG] ${reason} userId=${userId || '-'} match.status=${state.match.status} ` +
    `teamSelectionLocked=${state.match.teamSelectionLocked} team=${team} players=${state.players.length}`
  );
}

function broadcastState(reason = null, userId = null) {
  const state = fullState();

  if (reason) {
    logStateForUser(reason, userId, state);
  }

  broadcastAll(state);
}

function broadcastClients(msg) {
  const raw = JSON.stringify(msg);
  for (const p of players.values()) {
    if (p.local && p.socket && p.socket.readyState === WebSocket.OPEN) p.socket.send(raw);
  }
}

function broadcastSpectators(msg) {
  const raw = JSON.stringify(msg);
  for (const ws of spectators) { if (ws.readyState === WebSocket.OPEN) ws.send(raw); }
}

function broadcastAll(msg) { broadcastClients(msg); broadcastSpectators(msg); }

function sendToActivePlayers(message) {

  const raw = JSON.stringify(message);

  for (const [, player] of getActivePlayers()) {

    if (
      player.local &&
      player.socket &&
      player.socket.readyState === WebSocket.OPEN
    ) {
      player.socket.send(raw);
    }
  }
}

function sendToRestartPlayers(message) {
  const raw = JSON.stringify(message);

  for (const [, player] of getRestartPlayers()) {
    if (
      player.local &&
      player.socket &&
      player.socket.readyState === WebSocket.OPEN
    ) {
      player.socket.send(raw);
    }
  }
}

function restartVotePayload() {
  if (!restartVote) return null;

  return {
    id: restartVote.id,
    requestedBy: restartVote.requestedBy,
    requestedByName: restartVote.requestedByName,
    voters: [...restartVote.voters],
    accepted: [...restartVote.accepted]
  };
}

function broadcastRestartVotePeer(type, extra = {}) {
  broadcastPeers({
    type,
    origin: COORDINATOR_ID,
    vote: restartVotePayload(),
    ...extra
  });
}

function emitRestartVoteUpdate(replicate = true) {
  if (!restartVote) return;

  const message = {
    type: 'restart_vote_update',
    voteId: restartVote.id,
    accepted: restartVote.accepted.size,
    total: restartVote.voters.size
  };

  sendToRestartPlayers(message);

  if (replicate) {
    broadcastRestartVotePeer('restart_vote_update_replicate');
  }
}

function cancelRestartVote(type, message, replicate = true) {
  if (!restartVote) return;

  const voteId = restartVote.id;

  console.log(
    `[RESTART VOTE] cancelled voteId=${voteId} type=${type} message=${message}`
  );

  sendToRestartPlayers({
    type,
    voteId,
    message
  });

  if (replicate) {
    broadcastRestartVotePeer('restart_vote_cancel_replicate', {
      voteId,
      clientType: type,
      message
    });
  }

  restartVote = null;
}

function approveRestartVote(replicate = true) {
  if (!restartVote) return;

  const voteId = restartVote.id;
  const message = 'Todos aceptaron. Reiniciando partido...';

  console.log(
    `[RESTART VOTE] approved voteId=${voteId} accepted=${restartVote.accepted.size} total=${restartVote.voters.size}`
  );

  sendToRestartPlayers({
    type: 'restart_vote_approved',
    voteId,
    message
  });

  if (replicate) {
    broadcastRestartVotePeer('restart_vote_approved_replicate', {
      voteId,
      message
    });
  }

  restartVote = null;
  restartMatch(!replicate);
}

function reconcileRestartVote(replicate = true) {
  if (!restartVote) return;

  const connectedVoters = new Set(
    getRestartPlayers()
      .map(([uid]) => uid)
      .filter(uid => restartVote.voters.has(uid))
  );

  let changed = false;

  for (const uid of [...restartVote.voters]) {
    if (!connectedVoters.has(uid)) {
      restartVote.voters.delete(uid);
      restartVote.accepted.delete(uid);
      changed = true;
    }
  }

  if (restartVote.voters.size === 0) {
    cancelRestartVote(
      'restart_vote_cancelled',
      'La votacion de reinicio fue cancelada.',
      replicate
    );
    return;
  }

  if (restartVote.accepted.size >= restartVote.voters.size) {
    approveRestartVote(replicate);
    return;
  }

  if (changed) {
    emitRestartVoteUpdate(replicate);
  }
}

function createRestartVote(requestedBy, requestedByName, replicate = true) {
  const voters = getRestartPlayers().map(([uid]) => uid);

  if (voters.length === 0 || !voters.includes(requestedBy)) {
    console.log(
      `[RESTART VOTE] rejected_create requestedBy=${requestedBy} total=${voters.length}`
    );
    return false;
  }

  restartVote = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    requestedBy,
    requestedByName,
    voters: new Set(voters),
    accepted: new Set([requestedBy])
  };

  console.log(
    `[RESTART VOTE] created voteId=${restartVote.id} requestedBy=${requestedByName} ` +
    `accepted=${restartVote.accepted.size} total=${restartVote.voters.size}`
  );

  sendToRestartPlayers({
    type: 'restart_vote_request',
    voteId: restartVote.id,
    requestedBy: requestedByName,
    accepted: restartVote.accepted.size,
    total: restartVote.voters.size
  });

  if (replicate) {
    broadcastRestartVotePeer('restart_vote_request_replicate');
  }

  if (restartVote.accepted.size >= restartVote.voters.size) {
    approveRestartVote(replicate);
  }

  return true;
}

function importRestartVote(vote) {
  if (!vote || !vote.id || !Array.isArray(vote.voters)) return false;
  if (restartVote && restartVote.id !== vote.id) return false;

  restartVote = {
    id: String(vote.id),
    requestedBy: String(vote.requestedBy || ''),
    requestedByName: String(vote.requestedByName || ''),
    voters: new Set(vote.voters.map(uid => String(uid))),
    accepted: new Set(Array.isArray(vote.accepted) ? vote.accepted.map(uid => String(uid)) : [])
  };

  return true;
}

function broadcastPlayers() {
  broadcastAll({
    type: 'players_update',
    players: [...players.entries()].map(([uid, p]) => ({
      userId: uid,
      username: p.username,
      extras: { ...p.extras }
    }))
  });
}

function broadcastPeers(msg) {
  const raw = JSON.stringify(msg);
  for (const ws of peers.values()) { if (ws.readyState === WebSocket.OPEN) ws.send(raw); }
}

function sendMatchEvent(message, kind = 'info') {
  broadcastAll({ type: 'match_event', event: kind, name: kind, kind, message });
}

// ─── Chat ─────────────────────────────────────────────────────────────────────
function addChat(username, text, ts) {
  const msg = { username, text, ts };
  chatHistory.push(msg);
  if (chatHistory.length > MAX_CHAT_MSGS) chatHistory.shift();
  return msg;
}


// ─── Lógica del partido ───────────────────────────────────────────────────────
function resetBall() {
  ball.x = WORLD_WIDTH/2; ball.y = WORLD_HEIGHT/2; ball.vx = 0; ball.vy = 0;
}

function spawnPlayers() {
  for (const p of players.values()) {
    const team = p.extras.team || 'none';
    const base = SPAWN[team] || SPAWN.none;
    const jitter = 60;
    p.x = base.x + (Math.random()-0.5)*jitter;
    p.y = base.y + (Math.random()-0.5)*jitter;
    p.intent = { x: 0, y: 0 };
  }
  resolvePlayerCollisions(6);
}

function resolvePlayerCollisions(iterations = 2) {
  const list = [...players.values()].filter(p => !p.extras.eliminated);
  const minDistance = PLAYER_RADIUS * 2;

  for (let pass = 0; pass < iterations; pass++) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let dist = Math.hypot(dx, dy);

        if (dist >= minDistance) continue;

        if (dist < 0.001) {
          dx = 1;
          dy = 0;
          dist = 1;
        }

        const nx = dx / dist;
        const ny = dy / dist;
        const push = (minDistance - dist) / 2 + 0.01;

        a.x = Math.max(PLAYER_RADIUS, Math.min(WORLD_WIDTH - PLAYER_RADIUS, a.x - nx * push));
        a.y = Math.max(PLAYER_RADIUS, Math.min(WORLD_HEIGHT - PLAYER_RADIUS, a.y - ny * push));
        b.x = Math.max(PLAYER_RADIUS, Math.min(WORLD_WIDTH - PLAYER_RADIUS, b.x + nx * push));
        b.y = Math.max(PLAYER_RADIUS, Math.min(WORLD_HEIGHT - PLAYER_RADIUS, b.y + ny * push));
      }
    }
  }
}

function applyGoalPenalty(teamThatScored) {
  // El equipo que recibió el gol pierde 30 hp
  const penalizedTeam = teamThatScored === 'red' ? 'blue' : 'red';
  for (const p of players.values()) {
    if (p.extras.team === penalizedTeam) {
      p.extras.hp = Math.max(0, (p.extras.hp ?? 100) - GOAL_HP_PENALTY);
      if (p.extras.hp <= 0) p.extras.eliminated = true;
    }
  }
}

function checkGoal() {
  const goalTop    = (WORLD_HEIGHT - GOAL_WIDTH) / 2;
  const goalBottom = goalTop + GOAL_WIDTH;
  // Arco izquierdo → anota blue
  if (ball.x - BALL_RADIUS <= 0 && ball.y >= goalTop && ball.y <= goalBottom) return 'blue';
  // Arco derecho → anota red
  if (ball.x + BALL_RADIUS >= WORLD_WIDTH && ball.y >= goalTop && ball.y <= goalBottom) return 'red';
  return null;
}

function handleGoal(scorer) {
  score[scorer]++;

  if (score[scorer] >= WIN_SCORE) {
    match.status = 'finished';
    match.winner = scorer;
    match.timeLeft = 0;
    match.teamSelectionLocked = false;

    resetBall();
    sendMatchEvent(
      `Ganaron los ${scorer === 'red' ? 'Rojos' : 'Azules'} por alcanzar ${WIN_SCORE} goles!`,
      'finished'
    );
    broadcastPeers({ type: 'score_replicate', origin: COORDINATOR_ID, score: { ...score } });
    broadcastPeers({ type: 'match_replicate', origin: COORDINATOR_ID, match: { ...match } });
    broadcastPeers({ type: 'ball_replicate', origin: COORDINATOR_ID, ball: { x:ball.x, y:ball.y, vx:ball.vx, vy:ball.vy } });
    broadcastState('after win_score');
    return;
  }

  applyGoalPenalty(scorer);
  const msg = `Gol de ${scorer === 'red' ? 'Rojos' : 'Azules'}! ${score.red}-${score.blue}`;
  sendMatchEvent(msg, 'goal');
  broadcastPeers({ type: 'score_replicate', origin: COORDINATOR_ID, score: { ...score } });
  broadcastPeers({ type: 'match_replicate', origin: COORDINATOR_ID, match: { ...match } });
  broadcastPeers({ type: 'players_replicate', origin: COORDINATOR_ID, players: snapshot() });

  setTimeout(() => {
    resetBall();
    spawnPlayers();
    broadcastPeers({ type: 'ball_replicate', origin: COORDINATOR_ID, ball: { x:ball.x, y:ball.y, vx:ball.vx, vy:ball.vy } });
  }, 2000);
}

function startHalftime() {
  match.status   = 'halftime';
  match.timeLeft = HALFTIME_SEC;
  resetBall(); spawnPlayers();
  sendMatchEvent('¡Fin del primer tiempo! Entretiempo de 15 segundos.', 'halftime');
  broadcastPeers({ type: 'match_replicate', origin: COORDINATOR_ID, match: { ...match } });
}

function startSecondHalf() {
  match.status   = 'playing';
  match.half     = 2;
  match.timeLeft = HALF_DURATION_SEC;
  resetBall(); spawnPlayers();
  sendMatchEvent('¡Comienza el segundo tiempo!', 'start');
  broadcastPeers({ type: 'match_replicate', origin: COORDINATOR_ID, match: { ...match } });
}

function endMatch() {
  match.status = 'finished';
  match.timeLeft = 0;
  if (score.red > score.blue)       match.winner = 'red';
  else if (score.blue > score.red)  match.winner = 'blue';
  else                              match.winner = 'draw';
  const msg = match.winner === 'draw'
    ? '¡Empate! Partido finalizado.'
    : `¡Ganaron los ${match.winner === 'red' ? 'Rojos' : 'Azules'}! Partido finalizado.`;
  sendMatchEvent(msg, 'finished');
  broadcastPeers({ type: 'match_replicate', origin: COORDINATOR_ID, match: { ...match } });
}

function isActiveMatchStatus() {
  return match.status === 'team_selection' ||
    match.status === 'playing' ||
    match.status === 'halftime';
}

function endMatchIfNoPlayers(reason) {
  if (!isActiveMatchStatus() || players.size > 0) return false;

  restartVote = null;
  console.log(`[MATCH] Finalizando por falta de jugadores reason=${reason}`);
  endMatch();
  broadcastState(`after auto_end_no_players ${reason}`);
  return true;
}

function startMatch() {
  const previousStatus = match.status;

  const connectedPlayers =
    [...players.values()].filter(p => p.local || !p.local).length;

  console.log(
    `[START_MATCH] requested previousStatus=${previousStatus} connectedPlayers=${connectedPlayers}`
  );

  if (connectedPlayers < 2) {
    console.log('[START_MATCH] rejected reason=not_enough_players');
    return false;
  }

  score.red = 0;
  score.blue = 0;

  resetBall();

  for (const p of players.values()) {
    p.extras.hp = 100;
    p.extras.maxHp = 100;
    p.extras.eliminated = false;
    p.intent = { x: 0, y: 0 };
  }

  spawnPlayers();

  match.status = 'team_selection';
  match.half = 1;
  match.timeLeft = TEAM_SELECTION_SEC;
  match.teamSelectionLocked = false;
  match.winner = null;

  sendMatchEvent(
    'Selección de equipos iniciada. Tienen 10 segundos.',
    'prestart'
  );

 broadcastPeers({
  type: 'start_match_replicate',
  origin: COORDINATOR_ID
});

  
  broadcastState('after start_match');

  return true;
}

function restartMatch(replicated = false) {

  restartVote = null;

  score.red = 0;
  score.blue = 0;

  resetBall();

  for (const p of players.values()) {

    p.extras.team = null;

    p.extras.hp = 100;

    p.extras.maxHp = 100;

    p.extras.eliminated = false;

    p.extras.lateJoiner = false;

    p.extras.out = false;

    p.intent = {
      x: 0,
      y: 0
    };
  }

  spawnPlayers();

  match.status = 'waiting';

  match.winner = null;

  match.half = 0;

  match.timeLeft = null;

  match.teamSelectionLocked = false;

  broadcastState('after restart_match');

  broadcastPlayers();

  if (!replicated) {

    broadcastPeers({
      type: 'restart_match_replicate',
      origin: COORDINATOR_ID
    });
  }
}

function updateBall(dt) {
  ball.x += ball.vx * dt; ball.y += ball.vy * dt;

  // Rebotes paredes
  if (ball.x - BALL_RADIUS <= 0)          { ball.x = BALL_RADIUS;            ball.vx =  Math.abs(ball.vx); }
  if (ball.x + BALL_RADIUS >= WORLD_WIDTH) { ball.x = WORLD_WIDTH-BALL_RADIUS; ball.vx = -Math.abs(ball.vx); }
  if (ball.y - BALL_RADIUS <= 0)           { ball.y = BALL_RADIUS;            ball.vy =  Math.abs(ball.vy); }
  if (ball.y + BALL_RADIUS >= WORLD_HEIGHT){ ball.y = WORLD_HEIGHT-BALL_RADIUS; ball.vy = -Math.abs(ball.vy); }

  ball.vx *= BALL_FRICTION; ball.vy *= BALL_FRICTION;

  // Colisión jugador-pelota
  for (const p of players.values()) {
    if (p.extras.eliminated) continue;
    const dx = ball.x - p.x, dy = ball.y - p.y;
    const dist = Math.hypot(dx, dy);
    const minDist = PLAYER_RADIUS + BALL_RADIUS;
    if (dist < minDist && dist > 0) {
      const nx = dx/dist, ny = dy/dist;
      // Separar pelota del jugador
      ball.x = p.x + nx*minDist;
      ball.y = p.y + ny*minDist;
      // Velocidad depende de la dirección del jugador
      const playerSpeed = Math.hypot(p.intent.x, p.intent.y);
      const impulse = Math.max(BALL_MIN_SPEED, playerSpeed * PLAYER_SPEED * 1.5);
      // Dirección: normal de colisión + aporte del intent del jugador
      const dirX = nx + p.intent.x * 0.6;
      const dirY = ny + p.intent.y * 0.6;
      const dirLen = Math.hypot(dirX, dirY) || 1;
      ball.vx = (dirX/dirLen) * impulse;
      ball.vy = (dirY/dirLen) * impulse;
    }
  }

  const scorer = checkGoal();
  if (scorer) handleGoal(scorer);
}

// ─── Game Loop ────────────────────────────────────────────────────────────────
let lastTick = Date.now(), tickCount = 0;

function tick() {
  const now = Date.now();
  const dt = Math.min(0.05, (now - lastTick) / 1000);
  lastTick = now;

  if (match.status === 'team_selection') {
    match.timeLeft = Math.max(0, match.timeLeft - dt);
    if (match.timeLeft <= 0) {
      match.teamSelectionLocked = true;
      match.status = 'playing';
      match.half = 1;
      match.timeLeft = HALF_DURATION_SEC;
      spawnPlayers();
      console.log(
        `[MATCH STATUS] team_selection -> playing teamSelectionLocked=${match.teamSelectionLocked} timeLeft=${match.timeLeft}`
      );
      sendMatchEvent('Equipos bloqueados. Comienza el partido.', 'start');
      broadcastPeers({ type: 'match_replicate', origin: COORDINATOR_ID, match: { ...match } });
      broadcastState('after team_selection_to_playing');
    }
  } else if (match.status === 'playing') {
    match.timeLeft = Math.max(0, match.timeLeft - dt);
    if (match.timeLeft <= 0) {
      if (match.half === 1) startHalftime();
      else endMatch();
    }
  } else if (match.status === 'halftime') {
    match.timeLeft = Math.max(0, match.timeLeft - dt);
    if (match.timeLeft <= 0) startSecondHalf();
  }

  if (match.status === 'playing' || match.status === 'team_selection') {
    for (const p of players.values()) {
      if (p.extras.eliminated) continue;

      const ix = p.intent.x;
      const iy = p.intent.y;
      const mag = Math.hypot(ix, iy);

      if (mag > 0) {
        p.x += (ix / mag) * PLAYER_SPEED * dt;
        p.y += (iy / mag) * PLAYER_SPEED * dt;
      }

      p.x = Math.max(PLAYER_RADIUS, Math.min(WORLD_WIDTH - PLAYER_RADIUS, p.x));
      p.y = Math.max(PLAYER_RADIUS, Math.min(WORLD_HEIGHT - PLAYER_RADIUS, p.y));
    }

    resolvePlayerCollisions(3);
  }

  const isPhysicsLeader = [...peers.keys()].every(id => COORDINATOR_ID < id) || peers.size === 0;
  if (isPhysicsLeader && match.status === 'playing') {
    updateBall(dt);
    if (tickCount % 3 === 0) {
      broadcastPeers({ type: 'ball_replicate', origin: COORDINATOR_ID, ball: { x:ball.x, y:ball.y, vx:ball.vx, vy:ball.vy } });
    }
  }

  broadcastAll(fullState());

  if (tickCount % 5 === 0) {
    const lp = [];
    for (const [uid, p] of players.entries()) {
      if (p.local) lp.push({ userId: uid, x: p.x, y: p.y });
    }
    if (lp.length > 0) broadcastPeers({ type: 'positions_replicate', origin: COORDINATOR_ID, players: lp });
  }

  tickCount++;
}

setInterval(tick, TICK_MS);

// ─── authFetch con fallback ───────────────────────────────────────────────────
async function authFetch(path, options = {}) {
  const urlsToTry = [currentLeaderUrl, ...AUTH_URLS.filter(u => u !== currentLeaderUrl)];
  for (const base of urlsToTry) {
    try {
      const res = await fetch(`${base}${path}`, options);
      if (res.status === 503) {
        const body = await res.json().catch(() => ({}));
        if (body.leaderUrl) { currentLeaderUrl = body.leaderUrl; return await fetch(`${currentLeaderUrl}${path}`, options); }
      }
      return res;
    } catch { console.warn(`[AUTH] ${base} no disponible`); }
  }
  throw new Error('Ningún auth-service disponible');
}

// ─── Heartbeat ────────────────────────────────────────────────────────────────
async function sendHeartbeat() {
  const localPlayers = [...players.values()].filter(p => p.local).length;
  const body = JSON.stringify({ coordinatorId: COORDINATOR_ID, publicUrl: PUBLIC_URL, peerUrl: PEER_URL, connectedPlayers: localPlayers, uptime: Math.floor(process.uptime()) });
  for (const authUrl of AUTH_URLS) {
    try { await fetch(`${authUrl}/heartbeat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }); }
    catch (err) { console.warn(`[HEARTBEAT] falló para ${authUrl}: ${err.message}`); }
  }
}
setInterval(sendHeartbeat, 2000); sendHeartbeat();

// ─── Descubrimiento de peers ──────────────────────────────────────────────────
async function discoverPeers() {
  try {
    const res = await authFetch('/peers');
    if (!res.ok) return;
    const { peers: peerList } = await res.json();
    for (const peer of peerList) {
      if (peer.coordinatorId === COORDINATOR_ID) continue;
      if (peers.has(peer.coordinatorId)) continue;
      if (COORDINATOR_ID < peer.coordinatorId) connectToPeer(peer.coordinatorId, peer.peerUrl);
    }
  } catch (err) { console.warn(`[PEERS] Error: ${err.message}`); }
}

function connectToPeer(peerId, peerUrl) {
  // Asegurarse que la URL tenga la ruta /peer
  const fullUrl = peerUrl.endsWith('/peer') ? peerUrl : `${peerUrl}/peer`;
  console.log(`[PEER] Conectando a ${peerId} en ${fullUrl}`);
  const ws = new WebSocket(fullUrl, {
    headers: { 'ngrok-skip-browser-warning': 'true' }
  });
  ws.on('open', () => {
    ws.send(JSON.stringify({ type: 'hello', coordinatorId: COORDINATOR_ID }));
    peers.set(peerId, ws);
    console.log(`[PEER] Conectado a ${peerId}`);
    for (const [uid, p] of players.entries()) {
      if (p.local) ws.send(JSON.stringify({ type: 'player_joined', origin: COORDINATOR_ID, userId: uid, username: p.username, x: p.x, y: p.y, extras: p.extras }));
    }
    ws.send(JSON.stringify({ type: 'score_replicate', origin: COORDINATOR_ID, score: { ...score } }));
    ws.send(JSON.stringify({ type: 'match_replicate', origin: COORDINATOR_ID, match: { ...match } }));
    ws.send(JSON.stringify({ type: 'chat_history_replicate', origin: COORDINATOR_ID, messages: chatHistory }));
  });
  ws.on('message', (raw) => handlePeerMessage(raw, peerId));
  ws.on('close', () => { peers.delete(peerId); removePeerPlayers(peerId); console.log(`[PEER] Desconectado: ${peerId}`); });
  ws.on('error', (err) => console.warn(`[PEER ERROR] ${peerId}: ${err.message}`));
}

function removePeerPlayers(peerId) {
  let removedRestartVoter = false;

  for (const [uid, p] of players.entries()) {
    if (!p.local && p.originCoord === peerId) {
      if (restartVote?.voters.has(uid)) removedRestartVoter = true;
      players.delete(uid);
    }
  }

  broadcastPlayers();

  if (removedRestartVoter) {
    reconcileRestartVote();
  }

  endMatchIfNoPlayers('peer_disconnected');
}

// ─── Mensajes entre peers ─────────────────────────────────────────────────────
function handlePeerMessage(raw, fromPeerId) {
  let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
  if (msg.origin === COORDINATOR_ID) return;

  switch (msg.type) {
    case 'hello': break;
    case 'player_joined': {
      const uid = String(msg.userId);
      if (!players.has(uid)) {
        players.set(uid, { username: msg.username, socket: null, local: false, originCoord: msg.origin, x: msg.x ?? WORLD_WIDTH/2, y: msg.y ?? WORLD_HEIGHT/2, intent: {x:0,y:0}, extras: msg.extras || { team: null, hp: 100, maxHp: 100, eliminated: false }, ping: null });
        broadcastPlayers();
      }
      break;
    }
    case 'player_left': {
      const uid = String(msg.userId);
      if (players.has(uid) && !players.get(uid).local) {
        players.delete(uid);
        broadcastPlayers();
        endMatchIfNoPlayers('peer_player_left');
      }
      break;
    }
    case 'intent_replicate': {
      const p = players.get(String(msg.userId));
      if (p && msg.intent?.dir) p.intent = { x: Math.sign(msg.intent.dir.x), y: Math.sign(msg.intent.dir.y) };
      break;
    }
    case 'extras_replicate': {
      const p = players.get(String(msg.userId));
      if (p && msg.extras) {
        p.extras = { ...p.extras, ...msg.extras };
        broadcastState('after peer extras_replicate', String(msg.userId));
      }
      break;
    }
    case 'ping_replicate': {
      const p = players.get(String(msg.userId));
      if (p) p.ping = msg.ping;
      break;
    }
    case 'positions_replicate': {
      if (!Array.isArray(msg.players)) break;
      for (const e of msg.players) { const p = players.get(String(e.userId)); if (p && !p.local) { p.x = e.x; p.y = e.y; } }
      break;
    }
    case 'players_replicate': {
      if (!Array.isArray(msg.players)) break;
      for (const e of msg.players) { const p = players.get(String(e.userId)); if (p) p.extras = { ...p.extras, ...e.extras }; }
      break;
    }
    case 'ball_replicate': {
      const isPhysicsLeader = [...peers.keys()].every(id => COORDINATOR_ID < id) || peers.size === 0;
      if (!isPhysicsLeader && msg.ball) { ball.x = msg.ball.x; ball.y = msg.ball.y; ball.vx = msg.ball.vx; ball.vy = msg.ball.vy; }
      break;
    }
    case 'score_replicate': { if (msg.score) { score.red = msg.score.red; score.blue = msg.score.blue; } break; }
    case 'match_replicate': { if (msg.match) Object.assign(match, msg.match); break; }
    case 'restart_vote_request_replicate': {
      if (!restartVote && importRestartVote(msg.vote)) {
        sendToRestartPlayers({
          type: 'restart_vote_request',
          voteId: restartVote.id,
          requestedBy: restartVote.requestedByName,
          accepted: restartVote.accepted.size,
          total: restartVote.voters.size
        });
      }
      break;
    }
    case 'restart_vote_update_replicate': {
      if (importRestartVote(msg.vote)) {
        emitRestartVoteUpdate(false);
      }
      break;
    }
    case 'restart_vote_cancel_replicate': {
      if (!restartVote || (msg.voteId && restartVote.id !== msg.voteId)) break;

      sendToRestartPlayers({
        type: msg.clientType === 'restart_vote_cancelled'
          ? 'restart_vote_cancelled'
          : 'restart_vote_rejected',
        voteId: restartVote.id,
        message: msg.message || 'No se reinici\u00f3 el partido.'
      });

      restartVote = null;
      break;
    }
    case 'restart_vote_approved_replicate': {
      if (!restartVote || (msg.voteId && restartVote.id !== msg.voteId)) break;

      sendToRestartPlayers({
        type: 'restart_vote_approved',
        voteId: restartVote.id,
        message: msg.message || 'Todos aceptaron. Reiniciando partido...'
      });

      restartVote = null;
      restartMatch(true);
      break;
    }
    case 'chat_replicate': {
      if (msg.message) { chatHistory.push(msg.message); if (chatHistory.length > MAX_CHAT_MSGS) chatHistory.shift(); broadcastAll({ type: 'chat_message', message: msg.message }); }
      break;
    }
    case 'chat_history_replicate': {
      if (chatHistory.length === 0 && Array.isArray(msg.messages)) chatHistory.push(...msg.messages.slice(-MAX_CHAT_MSGS));
      break;
    }
    case 'start_match_replicate': {

  if (match.status === 'waiting') {
    startMatch();
  }

  break;
}
    case 'restart_match_replicate': {
  restartMatch(true);
  break;
}
  }
}

// ─── Peer server ──────────────────────────────────────────────────────────────
peerWss.on('connection', (ws) => {
  let peerId = null;
  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'hello' && !peerId) {
      peerId = msg.coordinatorId;
      if (peers.has(peerId) && COORDINATOR_ID > peerId) { ws.close(); return; }
      peers.set(peerId, ws);
      console.log(`[PEER] ${peerId} entró al mesh`);
      for (const [uid, p] of players.entries()) {
        if (p.local) ws.send(JSON.stringify({ type: 'player_joined', origin: COORDINATOR_ID, userId: uid, username: p.username, x: p.x, y: p.y, extras: p.extras }));
      }
      ws.send(JSON.stringify({ type: 'score_replicate', origin: COORDINATOR_ID, score: { ...score } }));
      ws.send(JSON.stringify({ type: 'match_replicate', origin: COORDINATOR_ID, match: { ...match } }));
      ws.send(JSON.stringify({ type: 'chat_history_replicate', origin: COORDINATOR_ID, messages: chatHistory }));
      return;
    }
    if (peerId) handlePeerMessage(raw, peerId);
  });
  ws.on('close', () => { if (peerId) { peers.delete(peerId); removePeerPlayers(peerId); console.log(`[PEER] ${peerId} salió del mesh`); } });
  ws.on('error', (err) => console.warn(`[PEER SERVER ERROR] ${err.message}`));
});

// ─── Upgrade ──────────────────────────────────────────────────────────────────
server.on('upgrade', (req, socket, head) => {
  const { pathname, query } = url.parse(req.url, true);
  if (pathname === '/peer') { peerWss.handleUpgrade(req, socket, head, (ws) => peerWss.emit('connection', ws, req)); return; }
  if (pathname === '/spectator') { specWss.handleUpgrade(req, socket, head, (ws) => specWss.emit('connection', ws, req)); return; }
  if (pathname === '/connect') {
    const token = query.token;
    if (!token) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
    let payload;
    try { payload = jwt.verify(token, JWT_SECRET); }
    catch { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, payload));
    return;
  }
  socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); socket.destroy();
});

// ─── Espectadores ─────────────────────────────────────────────────────────────
specWss.on('connection', (ws) => {

  console.log('[SPECTATOR] Conectado');

  spectators.add(ws);

  ws.send(JSON.stringify({
    type: 'welcome',
    you: null,
    spectator: true,
    coordinatorId: COORDINATOR_ID,
    world: {
      width: WORLD_WIDTH,
      height: WORLD_HEIGHT,
      playerRadius: PLAYER_RADIUS,
      tickRate: TICK_RATE
    }
  }));

  ws.send(JSON.stringify({
    type: 'chat_history',
    messages: chatHistory
  }));

  ws.on('message', (raw) => {

    let msg;

    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === 'ping') {
      ws.send(JSON.stringify({
        type: 'pong',
        sentAt: msg.sentAt
      }));
    }

  });

  ws.on('close', () => {
    spectators.delete(ws);
  });

  ws.on('error', (err) => {
    console.warn(`[SPECTATOR ERROR] ${err.message}`);
  });

});

// ─── Clientes ─────────────────────────────────────────────────────────────────
wss.on('connection', (ws, payload) => {
  const userId = String(payload.userId), username = payload.username;
  console.log(`[CONNECT] ${username} (${userId})`);

  const replacedRestartVoter =
    players.has(userId) &&
    players.get(userId).local &&
    restartVote?.voters.has(userId);

  if (players.has(userId) && players.get(userId).local) {
    players.get(userId).socket.close(4001, 'Nueva sesión');
    players.delete(userId);
  }

  const startX = PLAYER_RADIUS + Math.random() * (WORLD_WIDTH  - 2*PLAYER_RADIUS);
  const startY = PLAYER_RADIUS + Math.random() * (WORLD_HEIGHT - 2*PLAYER_RADIUS);
 const lateJoiner = [
  'playing',
  'running',
  'in_progress',
  'first_half',
  'second_half',
  'halftime'
].includes(match.status);

  players.set(userId, {
    username, socket: ws, local: true, originCoord: COORDINATOR_ID,
    x: startX, y: startY, intent: {x:0,y:0},
    
  extras: {
  team: null,
  hp: lateJoiner ? 0 : 100,
  maxHp: 100,
  eliminated: lateJoiner,
  lateJoiner
}, 
    ping: null,
  });

  ws.send(JSON.stringify({ type: 'welcome', you: { userId, username }, coordinatorId: COORDINATOR_ID, world: { width: WORLD_WIDTH, height: WORLD_HEIGHT, playerRadius: PLAYER_RADIUS, tickRate: TICK_RATE } }));
  ws.send(JSON.stringify({ type: 'chat_history', messages: chatHistory }));

  if (replacedRestartVoter) {
    reconcileRestartVote();
  }

  broadcastPlayers();
  broadcastPeers({ type: 'player_joined', origin: COORDINATOR_ID, userId, username, x: startX, y: startY, extras: players.get(userId).extras });
ws.on('message', (raw) => {

  let msg;

  try {
    msg = JSON.parse(raw.toString());
  } catch {
    return;
  }

  const p = players.get(userId);

  if (!p) return;

  // ─────────────────────────────────────────────
  // Votación de reinicio
  // ─────────────────────────────────────────────

  if (msg.type === 'restart_vote_request') {

    console.log(
      `[RESTART VOTE] request received userId=${userId} username=${username} team=${p.extras.team ?? null} match.status=${match.status}`
    );

    if (!hasRestartTeam(p)) {
      console.log(`[RESTART VOTE] request ignored userId=${userId} reason=no_team`);
      return;
    }

    if (restartVote) {
      console.log(`[RESTART VOTE] request ignored userId=${userId} reason=vote_pending voteId=${restartVote.id}`);
      return;
    }

    if (!createRestartVote(userId, username)) {
      ws.send(JSON.stringify({
        type: 'restart_vote_rejected',
        voteId: null,
        message: 'No hay jugadores con equipo para votar.'
      }));
    }

    return;
}

  
  if (msg.type === 'restart_vote_response') {

    console.log(
      `[RESTART VOTE] response received userId=${userId} username=${username} voteId=${msg.voteId} accepted=${msg.accepted}`
    );

    if (!restartVote) return;

    if (msg.voteId !== restartVote.id) return;

    reconcileRestartVote();

    if (!restartVote) return;

    if (!restartVote.voters.has(userId)) return;

    if (msg.accepted === false) {
      cancelRestartVote(
        'restart_vote_rejected',
        'No se reinici\u00f3 el partido.'
      );
      return;
    }

    if (msg.accepted !== true) {
      return;
    }

    restartVote.accepted.add(userId);

    console.log(
      `[RESTART VOTE] response saved voteId=${restartVote.id} accepted=${restartVote.accepted.size} total=${restartVote.voters.size}`
    );

    emitRestartVoteUpdate();

    if (
      restartVote &&
      restartVote.accepted.size >= restartVote.voters.size
    ) {
      approveRestartVote();
    }

    return;

  }

  // ─────────────────────────────────────────────
  // Ping
  // ─────────────────────────────────────────────

  if (msg.type === 'ping') {

    ws.send(JSON.stringify({
      type: 'pong',
      sentAt: msg.sentAt
    }));

    return;
  }

  // ─────────────────────────────────────────────
  // Iniciar partida
  // ─────────────────────────────────────────────

  if (msg.type === 'start_match') {

    const totalPlayers = players.size;
    const previousStatus = match.status;

    console.log(
      `[START_MATCH] received userId=${userId} username=${username} previousStatus=${previousStatus} players=${totalPlayers}`
    );

    if (totalPlayers < 2) {

      ws.send(JSON.stringify({
        type: 'error',
        message: 'Se necesitan mínimo 2 jugadores'
      }));

      return;
    }

    if (
      match.status === 'playing' ||
      match.status === 'halftime' ||
      match.status === 'team_selection'
    ) {
      return;
    }

    startMatch();

    console.log(
      `[START_MATCH] completed userId=${userId} previousStatus=${previousStatus} currentStatus=${match.status}`
    );

    return;
  }

  // ─────────────────────────────────────────────
  // Latencia
  // ─────────────────────────────────────────────

  if (msg.type === 'latency_update') {

    if (typeof msg.ping === 'number') {

      p.ping = msg.ping;

      broadcastPeers({
        type: 'ping_replicate',
        origin: COORDINATOR_ID,
        userId,
        ping: msg.ping
      });
    }

    return;
  }

  // ─────────────────────────────────────────────
  // Movimiento
  // ─────────────────────────────────────────────

  if (msg.type === 'intent') {

    if (
      p.extras.eliminated ||
      p.extras.lateJoiner
    ) {
      return;
    }

    const dir = msg.intent?.dir;

    if (
      !dir ||
      typeof dir.x !== 'number' ||
      typeof dir.y !== 'number'
    ) {
      return;
    }

    p.intent = {
      x: Math.sign(dir.x),
      y: Math.sign(dir.y)
    };

    broadcastPeers({
      type: 'intent_replicate',
      origin: COORDINATOR_ID,
      userId,
      intent: {
        dir: p.intent
      }
    });

    return;
  }

  // ─────────────────────────────────────────────
  // Extras
  // ─────────────────────────────────────────────

  if (msg.type === 'extras_update') {

    console.log(
      `[EXTRAS UPDATE] received userId=${userId} username=${username} match.status=${match.status} ` +
      `teamSelectionLocked=${match.teamSelectionLocked} extras=${JSON.stringify(msg.extras)}`
    );

    if (p.extras.lateJoiner) {
      console.log(`[EXTRAS UPDATE] rejected userId=${userId} reason=lateJoiner`);
      return;
    }

    if (
      !msg.extras ||
      typeof msg.extras !== 'object' ||
      Array.isArray(msg.extras)
    ) {
      console.log(`[EXTRAS UPDATE] rejected userId=${userId} reason=invalid_extras`);
      return;
    }

    if (
      JSON.stringify(msg.extras).length > 1024
    ) {
      console.log(`[EXTRAS UPDATE] rejected userId=${userId} reason=extras_too_large`);
      return;
    }

    if (msg.extras.team !== undefined) {

      if (match.teamSelectionLocked) {
        console.log(`[EXTRAS UPDATE] rejected userId=${userId} reason=team_selection_locked`);
        return;
      }

      if (
        !['red', 'blue']
          .includes(msg.extras.team)
      ) {
        console.log(`[EXTRAS UPDATE] rejected userId=${userId} reason=invalid_team team=${msg.extras.team}`);
        return;
      }
    }

    p.extras = {
      ...p.extras,
      ...msg.extras
    };

    console.log(
      `[EXTRAS UPDATE] saved userId=${userId} team=${p.extras.team ?? null} extras=${JSON.stringify(p.extras)}`
    );

    broadcastPeers({
      type: 'extras_replicate',
      origin: COORDINATOR_ID,
      userId,
      extras: p.extras
    });

    broadcastState('after extras_update', userId);

    return;
  }

  // ─────────────────────────────────────────────
  // Chat
  // ─────────────────────────────────────────────

  if (msg.type === 'chat') {

    const text =
      String(msg.text || '').trim();

    if (
      !text ||
      text.length > MAX_CHAT_LEN
    ) {
      return;
    }

    const last =
      chatLastMsg.get(userId) || 0;

    if (
      Date.now() - last <
      CHAT_RATE_MS
    ) {
      return;
    }

    chatLastMsg.set(
      userId,
      Date.now()
    );

    const chatMsg =
      addChat(
        username,
        text,
        Date.now()
      );

    broadcastAll({
  type: 'chat_message',
  message: chatMsg
});

    broadcastPeers({
      type: 'chat_replicate',
      origin: COORDINATOR_ID,
      message: chatMsg
    });

    return;
  }

});

   ws.on('close', () => {
    const current = players.get(userId);

    if (current && current.socket === ws) {
      const wasRestartVoter = restartVote?.voters.has(userId);

      players.delete(userId);

      console.log(
        `[DISCONNECT] ${username} (${userId})`
      );

      broadcastPlayers();

      broadcastPeers({
        type: 'player_left',
        origin: COORDINATOR_ID,
        userId
      });

      if (wasRestartVoter) {
        reconcileRestartVote();
      }

      endMatchIfNoPlayers('local_player_left');
    }
  });

  ws.on('error', (err) => {
    console.error(
      `[WS ERROR] ${username}: ${err.message}`
    );
  });

}); 

// ─── Arrancar ─────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`[OK] Coordinador "${COORDINATOR_ID}"`);
  console.log(`     Clientes    : ws://localhost:${PORT}/connect?token=<JWT>`);
  console.log(`     Espectadores: ws://localhost:${PORT}/spectator`);
  console.log(`     Peers       : ws://localhost:${PORT}/peer`);
  console.log(`     Health      : http://localhost:${PORT}/health`);
  setTimeout(discoverPeers, 1000);
  setInterval(discoverPeers, 5000);
});
