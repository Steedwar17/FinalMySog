/**
 * GameClient — módulo de cliente del juego.
 *
 * Este módulo se encarga de:
 *  - Capturar input del teclado (WASD / flechas) y emitir "intenciones de movimiento".
 *  - Correr el game loop de renderizado a 60 FPS.
 *  - Dibujar el estado de juego en un canvas.
 *
 * Lo que NO hace (ustedes lo hacen):
 *  - Calcular posiciones (eso es trabajo del SERVIDOR; el servidor es autoritativo).
 *  - Conectarse por WebSocket.
 *  - Mantener la lista de jugadores.
 *
 * USO:
 *
 *   import { createGame } from './game.js';
 *
 *   const game = createGame({
 *     canvas: document.getElementById('game'),
 *
 *     // Se llama cuando la intención del jugador local cambia
 *     // (ej: empezó a mover hacia la derecha, dejó de moverse, etc.)
 *     // Acá enviás el mensaje WS al coordinador.
 *     onIntent: (intent) => {
 *       ws.send(JSON.stringify({ type: 'intent', intent }));
 *     },
 *
 *     // Se llama 60 veces por segundo para obtener qué dibujar.
 *     // Devolvé el state actual que recibiste por WS del coordinador.
 *     getRenderState: () => currentGameState,
 *
 *     // ID del jugador local (lo conocés del JWT/welcome).
 *     // Sirve para resaltarlo y para no dibujar tu nombre encima tuyo.
 *     localPlayerId: myUserId,
 *
 *     options: {
 *       worldWidth: 800,
 *       worldHeight: 600,
 *       playerRadius: 20,
 *     }
 *   });
 *
 *   game.start();   // arranca el game loop
 *   game.stop();    // pausa
 *   game.destroy(); // libera el canvas y los listeners
 *
 * FORMATO DEL STATE QUE DEVUELVE getRenderState():
 *
 *   {
 *     players: [
 *       {
 *         userId: number,         // OBLIGATORIO
 *         username: string,       // OBLIGATORIO
 *         x: number,              // OBLIGATORIO
 *         y: number,              // OBLIGATORIO
 *         extras: { ... }         // OPCIONAL: cualquier dato extra (color, etc.)
 *       },
 *       ...
 *     ]
 *   }
 *
 * FORMATO DE LA INTENT QUE EMITE onIntent():
 *
 *   { type: 'move', dir: { x: -1|0|1, y: -1|0|1 } }
 *
 *   Ejemplos:
 *     dir: { x: 0, y: 0 }     -> jugador soltó las teclas, queda quieto
 *     dir: { x: 1, y: 0 }     -> moviéndose a la derecha
 *     dir: { x: -1, y: -1 }   -> moviéndose en diagonal arriba-izquierda
 *
 *   La intent se EMITE solo cuando la dirección cambia (no en cada frame).
 *   Esto evita inundar el WS con mensajes redundantes.
 */

export function createGame(config) {
  const {
    canvas,
    onIntent,
    getRenderState,
    localPlayerId,
    options = {}
  } = config;

  if (!canvas) throw new Error('createGame: canvas es requerido');
  if (typeof onIntent !== 'function') throw new Error('createGame: onIntent es requerido');
  if (typeof getRenderState !== 'function') throw new Error('createGame: getRenderState es requerido');

  const opts = {
    worldWidth: 800,
    worldHeight: 600,
    playerRadius: 20,
    backgroundColor: '#0f1419',
    gridColor: '#1f2730',
    gridSize: 40,
    goalWidth: 18,
    goalHeight: 150,
    fieldMargin: 26,
    ballRadius: 12,
    inputEnabled: true,
    ...options
  };

  canvas.width = opts.worldWidth;
  canvas.height = opts.worldHeight;
  const ctx = canvas.getContext('2d');

  // --- Input handling ---
  const keys = new Set();
  let lastIntent = { x: 0, y: 0 };

  function computeDirection() {
    let x = 0, y = 0;
    if (keys.has('ArrowLeft')  || keys.has('KeyA')) x -= 1;
    if (keys.has('ArrowRight') || keys.has('KeyD')) x += 1;
    if (keys.has('ArrowUp')    || keys.has('KeyW')) y -= 1;
    if (keys.has('ArrowDown')  || keys.has('KeyS')) y += 1;
    return { x, y };
  }

  function maybeEmitIntent() {
    const dir = computeDirection();
    if (dir.x !== lastIntent.x || dir.y !== lastIntent.y) {
      lastIntent = dir;
      onIntent({ type: 'move', dir });
    }
  }

  function onKeyDown(e) {
    // Ignorar si el foco está en un input
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (keys.has(e.code)) return; // ya estaba presionada
    keys.add(e.code);
    if (isMovementKey(e.code)) {
      e.preventDefault();
      maybeEmitIntent();
    }
  }

  function onKeyUp(e) {
    if (!keys.has(e.code)) return;
    keys.delete(e.code);
    if (isMovementKey(e.code)) {
      e.preventDefault();
      maybeEmitIntent();
    }
  }

  function onBlur() {
    // Si la ventana pierde foco, soltamos todo (evita "tecla pegada")
    if (keys.size === 0) return;
    keys.clear();
    maybeEmitIntent();
  }

  function isMovementKey(code) {
    return ['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','KeyA','KeyD','KeyW','KeyS'].includes(code);
  }

  // --- Render ---
  function drawBackground() {
    ctx.fillStyle = opts.backgroundColor;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.strokeStyle = opts.gridColor;
    ctx.lineWidth = 1;
    for (let x = 0; x <= canvas.width; x += opts.gridSize) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, canvas.height);
      ctx.stroke();
    }
    for (let y = 0; y <= canvas.height; y += opts.gridSize) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(canvas.width, y);
      ctx.stroke();
    }

    drawField();
  }

  function drawField() {
    const midX = canvas.width / 2;
    const midY = canvas.height / 2;
    const margin = opts.fieldMargin;
    const goalTop = midY - opts.goalHeight / 2;
    const boxDepth = Math.min(150, canvas.width * 0.16);
    const boxHeight = Math.min(280, canvas.height * 0.42);
    const boxTop = midY - boxHeight / 2;

    ctx.save();
    ctx.strokeStyle = 'rgba(230, 230, 255, 0.48)';
    ctx.lineWidth = 3;
    ctx.strokeRect(margin, margin, canvas.width - margin * 2, canvas.height - margin * 2);

    ctx.strokeStyle = 'rgba(230, 230, 255, 0.20)';
    ctx.lineWidth = 2;
    ctx.strokeRect(margin, boxTop, boxDepth, boxHeight);
    ctx.strokeRect(canvas.width - margin - boxDepth, boxTop, boxDepth, boxHeight);

    ctx.beginPath();
    ctx.arc(margin, margin, 18, 0, Math.PI / 2);
    ctx.arc(canvas.width - margin, margin, 18, Math.PI / 2, Math.PI);
    ctx.arc(canvas.width - margin, canvas.height - margin, 18, Math.PI, Math.PI * 1.5);
    ctx.arc(margin, canvas.height - margin, 18, Math.PI * 1.5, Math.PI * 2);
    ctx.stroke();

    ctx.strokeStyle = 'rgba(230, 230, 255, 0.26)';
    ctx.setLineDash([8, 10]);
    ctx.beginPath();
    ctx.moveTo(midX, margin);
    ctx.lineTo(midX, canvas.height - margin);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.beginPath();
    ctx.arc(midX, midY, 70, 0, Math.PI * 2);
    ctx.stroke();

    ctx.fillStyle = 'rgba(255, 68, 68, 0.28)';
    ctx.fillRect(0, goalTop, opts.goalWidth, opts.goalHeight);
    ctx.fillStyle = 'rgba(68, 102, 255, 0.28)';
    ctx.fillRect(canvas.width - opts.goalWidth, goalTop, opts.goalWidth, opts.goalHeight);

    ctx.fillStyle = 'rgba(255, 255, 255, 0.75)';
    ctx.fillRect(0, goalTop - 4, opts.goalWidth + margin, 4);
    ctx.fillRect(0, goalTop + opts.goalHeight, opts.goalWidth + margin, 4);
    ctx.fillRect(canvas.width - opts.goalWidth - margin, goalTop - 4, opts.goalWidth + margin, 4);
    ctx.fillRect(canvas.width - opts.goalWidth - margin, goalTop + opts.goalHeight, opts.goalWidth + margin, 4);
    ctx.restore();
  }

  function drawBall(ball) {
    if (!ball || !Number.isFinite(ball.x) || !Number.isFinite(ball.y)) return;

    const radius = Number.isFinite(ball.radius) ? ball.radius : opts.ballRadius;
    const vx = Number.isFinite(ball.vx) ? ball.vx : Number.isFinite(ball.velocityX) ? ball.velocityX : 0;
    const vy = Number.isFinite(ball.vy) ? ball.vy : Number.isFinite(ball.velocityY) ? ball.velocityY : 0;
    const speed = Number.isFinite(ball.speed) ? ball.speed : Math.hypot(vx, vy);
    const trailScale = Math.min(34, speed / 24);

    ctx.save();
    if (trailScale > 2) {
      const angle = Math.atan2(vy, vx);
      const tailX = Math.cos(angle) * trailScale;
      const tailY = Math.sin(angle) * trailScale;
      const gradient = ctx.createRadialGradient(
        ball.x - tailX,
        ball.y - tailY,
        1,
        ball.x - tailX,
        ball.y - tailY,
        radius + trailScale
      );
      gradient.addColorStop(0, 'rgba(255, 240, 170, 0.34)');
      gradient.addColorStop(1, 'rgba(255, 240, 170, 0)');
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(ball.x - tailX, ball.y - tailY, radius + trailScale, 0, Math.PI * 2);
      ctx.fill();
    }

    drawChampionsStyleBall(ball.x, ball.y, radius);
    ctx.restore();
  }

  function drawChampionsStyleBall(x, y, radius) {
    ctx.save();

    const body = ctx.createRadialGradient(
      x - radius * 0.35,
      y - radius * 0.45,
      radius * 0.18,
      x,
      y,
      radius
    );
    body.addColorStop(0, '#ffffff');
    body.addColorStop(0.62, '#f4f7ff');
    body.addColorStop(1, '#cfd8ef');

    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fillStyle = body;
    ctx.fill();
    ctx.clip();

    ctx.strokeStyle = '#102f73';
    ctx.lineWidth = Math.max(1.2, radius * 0.12);
    for (let i = 0; i < 5; i++) {
      const angle = -Math.PI / 2 + i * (Math.PI * 2 / 5);
      const sx = x + Math.cos(angle) * radius * 0.56;
      const sy = y + Math.sin(angle) * radius * 0.56;
      drawStar(sx, sy, radius * 0.32, radius * 0.13, angle + Math.PI / 2, '#153b91', '#e9f0ff');

      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.quadraticCurveTo(
        x + Math.cos(angle + 0.32) * radius * 0.48,
        y + Math.sin(angle + 0.32) * radius * 0.48,
        sx,
        sy
      );
      ctx.stroke();
    }

    ctx.beginPath();
    ctx.arc(x, y, radius * 0.22, 0, Math.PI * 2);
    ctx.fillStyle = '#f8fbff';
    ctx.fill();
    ctx.lineWidth = Math.max(0.8, radius * 0.08);
    ctx.strokeStyle = '#153b91';
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(x - radius * 0.28, y - radius * 0.32, radius * 0.22, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.72)';
    ctx.fill();

    ctx.restore();

    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#1a1a2e';
    ctx.stroke();
  }

  function drawStar(x, y, outerRadius, innerRadius, rotation, fill, stroke) {
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const radius = i % 2 === 0 ? outerRadius : innerRadius;
      const angle = rotation + i * Math.PI / 5;
      const px = x + Math.cos(angle) * radius;
      const py = y + Math.sin(angle) * radius;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.lineWidth = Math.max(0.6, outerRadius * 0.09);
    ctx.strokeStyle = stroke;
    ctx.stroke();
  }

  function drawItems(items) {
    if (!Array.isArray(items)) return;

    ctx.save();
    for (const item of items) {
      if (!Number.isFinite(item.x) || !Number.isFinite(item.y)) continue;
      const radius = Number.isFinite(item.radius) ? item.radius : 6;
      ctx.beginPath();
      ctx.arc(item.x, item.y, radius, 0, Math.PI * 2);
      ctx.fillStyle = item.color || '#44ff88';
      ctx.fill();
    }
    ctx.restore();
  }

  function drawZones(zones) {
    if (!Array.isArray(zones)) return;

    ctx.save();
    for (const zone of zones) {
      if (!Number.isFinite(zone.x) || !Number.isFinite(zone.y)) continue;
      ctx.strokeStyle = zone.color || 'rgba(255, 255, 255, 0.35)';
      ctx.fillStyle = zone.fill || 'rgba(255, 255, 255, 0.08)';
      ctx.lineWidth = Number.isFinite(zone.lineWidth) ? zone.lineWidth : 2;
      if (Number.isFinite(zone.radius)) {
        ctx.beginPath();
        ctx.arc(zone.x, zone.y, zone.radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      } else if (Number.isFinite(zone.width) && Number.isFinite(zone.height)) {
        ctx.fillRect(zone.x, zone.y, zone.width, zone.height);
        ctx.strokeRect(zone.x, zone.y, zone.width, zone.height);
      }
    }
    ctx.restore();
  }

  function drawPlayer(p, index) {
    const isLocal = p.userId === localPlayerId;
    const eliminated = isPlayerEliminated(p);
    const drawPos = eliminated ? eliminatedPosition(p, index) : { x: p.x, y: p.y };
    const hp = readPlayerHp(p);
    const maxHp = readPlayerMaxHp(p);

    // Color: si el extras trae color, usarlo. Si no, derivar uno del userId.
    const color = (p.extras && p.extras.color) || colorFromId(p.userId);

    ctx.save();
    if (eliminated) ctx.globalAlpha = 0.48;

    // Cuerpo
    ctx.beginPath();
    ctx.arc(drawPos.x, drawPos.y, opts.playerRadius, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    drawJerseyStripes(drawPos.x, drawPos.y, opts.playerRadius, color);

    // Borde (más grueso si es el jugador local)
    ctx.lineWidth = isLocal ? 3 : 1.5;
    ctx.strokeStyle = isLocal ? '#ffffff' : '#000000';
    ctx.stroke();

    // Username
    ctx.font = '14px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.fillStyle = '#e6e6e6';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    const text = p.username + (isLocal ? ' (tú)' : '');
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 3;
    ctx.strokeText(text, drawPos.x, drawPos.y - opts.playerRadius - 4);
    ctx.fillText(text, drawPos.x, drawPos.y - opts.playerRadius - 4);

    if (Number.isFinite(hp)) {
      drawHealthBar(drawPos.x, drawPos.y + opts.playerRadius + 8, hp, maxHp);
    }

    if (eliminated) {
      ctx.globalAlpha = 1;
      ctx.font = '700 11px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.fillStyle = '#ffd0d0';
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = 3;
      ctx.strokeText('OUT', drawPos.x, drawPos.y + 4);
      ctx.fillText('OUT', drawPos.x, drawPos.y + 4);
    }

    ctx.restore();
  }

  function drawJerseyStripes(x, y, radius, color) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, radius - 1, 0, Math.PI * 2);
    ctx.clip();

    const stripeCount = 7;
    const left = x - radius;
    const stripeWidth = (radius * 2) / stripeCount;
    const lightColor = lightenColor(color, 0.58);

    for (let index = 0; index < stripeCount; index++) {
      ctx.fillStyle = index % 2 === 0 ? color : lightColor;
      ctx.fillRect(left + index * stripeWidth, y - radius, stripeWidth + 0.8, radius * 2);
    }

    ctx.globalAlpha = 0.22;
    ctx.fillStyle = '#000000';
    ctx.fillRect(x - radius, y + radius * 0.18, radius * 2, radius * 0.14);
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  function lightenColor(color, amount) {
    const rgb = parseColor(color);
    if (!rgb) return 'rgba(255, 255, 255, 0.72)';
    const mix = (value) => Math.round(value + (255 - value) * amount);
    return `rgb(${mix(rgb.r)}, ${mix(rgb.g)}, ${mix(rgb.b)})`;
  }

  function parseColor(color) {
    if (typeof color !== 'string') return null;

    const hex = color.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (hex) {
      const raw = hex[1].length === 3
        ? hex[1].split('').map((part) => part + part).join('')
        : hex[1];
      return {
        r: parseInt(raw.slice(0, 2), 16),
        g: parseInt(raw.slice(2, 4), 16),
        b: parseInt(raw.slice(4, 6), 16)
      };
    }

    const hsl = color.trim().match(/^hsl\(([-\d.]+),\s*([-\d.]+)%?,\s*([-\d.]+)%?\)$/i);
    if (hsl) {
      return hslToRgb(Number(hsl[1]), Number(hsl[2]) / 100, Number(hsl[3]) / 100);
    }

    return null;
  }

  function hslToRgb(h, s, l) {
    const hue = ((h % 360) + 360) % 360 / 360;
    if (s === 0) {
      const value = Math.round(l * 255);
      return { r: value, g: value, b: value };
    }

    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const toRgb = (t) => {
      let wrapped = t;
      if (wrapped < 0) wrapped += 1;
      if (wrapped > 1) wrapped -= 1;
      if (wrapped < 1 / 6) return p + (q - p) * 6 * wrapped;
      if (wrapped < 1 / 2) return q;
      if (wrapped < 2 / 3) return p + (q - p) * (2 / 3 - wrapped) * 6;
      return p;
    };

    return {
      r: Math.round(toRgb(hue + 1 / 3) * 255),
      g: Math.round(toRgb(hue) * 255),
      b: Math.round(toRgb(hue - 1 / 3) * 255)
    };
  }

  function drawHealthBar(x, y, hp, maxHp) {
    const width = 42;
    const height = 5;
    const max = Number.isFinite(maxHp) && maxHp > 0 ? maxHp : 100;
    const ratio = Math.max(0, Math.min(1, hp / max));

    ctx.save();
    ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.fillRect(x - width / 2, y, width, height);
    ctx.fillStyle = ratio > 0.35 ? '#44ff88' : '#ff6666';
    ctx.fillRect(x - width / 2, y, width * ratio, height);
    ctx.restore();
  }

  // Hash determinista de userId -> color HSL
  function colorFromId(userId) {
    const hue = (Number(userId) * 137.508) % 360; // golden angle, da hues bien distribuidos
    return `hsl(${hue}, 70%, 55%)`;
  }

  function readPlayerHp(p) {
    const extras = p && p.extras ? p.extras : {};
    if (Number.isFinite(extras.hp)) return extras.hp;
    if (Number.isFinite(p.hp)) return p.hp;
    return null;
  }

  function readPlayerMaxHp(p) {
    const extras = p && p.extras ? p.extras : {};
    if (Number.isFinite(extras.maxHp)) return extras.maxHp;
    if (Number.isFinite(p.maxHp)) return p.maxHp;
    return 100;
  }

  function isPlayerEliminated(p) {
    const extras = p && p.extras ? p.extras : {};
    const hp = readPlayerHp(p);
    return extras.eliminated === true || extras.lateJoiner === true || p.eliminated === true || (Number.isFinite(hp) && hp <= 0);
  }

  function eliminatedPosition(p, index) {
    const team = p && p.extras ? p.extras.team : null;
    const slot = Math.max(0, index % 8);
    const y = Math.min(canvas.height - 44, 72 + slot * (opts.playerRadius * 2 + 18));

    if (team === 'blue') return { x: canvas.width - opts.playerRadius - 10, y };
    if (team === 'red') return { x: opts.playerRadius + 10, y };
    return {
      x: canvas.width / 2 + (slot - 3.5) * 48,
      y: canvas.height - opts.playerRadius - 10
    };
  }

  function render() {
    const state = getRenderState();
    drawBackground();

    if (!state || !Array.isArray(state.players)) return;

    drawZones(state.zones || (state.world && state.world.zones));
    drawItems(state.food || state.items || state.points);
    drawBall(state.ball || (state.game && state.game.ball));

    // Ordenar para que el local quede arriba (se ve sobre los demás)
    const sorted = [...state.players].sort((a, b) => {
      if (a.userId === localPlayerId) return 1;
      if (b.userId === localPlayerId) return -1;
      return 0;
    });

    sorted.forEach((p, index) => drawPlayer(p, index));
  }

  // --- Game loop ---
  let running = false;
  let rafId = null;

  function loop() {
    if (!running) return;
    render();
    rafId = requestAnimationFrame(loop);
  }

  // --- API pública ---
  function start() {
    if (running) return;
    running = true;
    if (opts.inputEnabled) {
      window.addEventListener('keydown', onKeyDown);
      window.addEventListener('keyup', onKeyUp);
      window.addEventListener('blur', onBlur);
    }
    loop();
  }

  function stop() {
    running = false;
    if (rafId !== null) cancelAnimationFrame(rafId);
    if (opts.inputEnabled) {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    }
  }

  function destroy() {
    stop();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  return { start, stop, destroy, options: opts };
}
