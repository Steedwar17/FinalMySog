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
  }

  function drawPlayer(p) {
    const isLocal = p.userId === localPlayerId;

    // Color: si el extras trae color, usarlo. Si no, derivar uno del userId.
    const color = (p.extras && p.extras.color) || colorFromId(p.userId);

    // Cuerpo
    ctx.beginPath();
    ctx.arc(p.x, p.y, opts.playerRadius, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();

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
    ctx.strokeText(text, p.x, p.y - opts.playerRadius - 4);
    ctx.fillText(text, p.x, p.y - opts.playerRadius - 4);
  }

  // Hash determinista de userId -> color HSL
  function colorFromId(userId) {
    const hue = (Number(userId) * 137.508) % 360; // golden angle, da hues bien distribuidos
    return `hsl(${hue}, 70%, 55%)`;
  }

  function render() {
    const state = getRenderState();
    drawBackground();

    if (!state || !Array.isArray(state.players)) return;

    // Ordenar para que el local quede arriba (se ve sobre los demás)
    const sorted = [...state.players].sort((a, b) => {
      if (a.userId === localPlayerId) return 1;
      if (b.userId === localPlayerId) return -1;
      return 0;
    });

    for (const p of sorted) drawPlayer(p);
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
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    loop();
  }

  function stop() {
    running = false;
    if (rafId !== null) cancelAnimationFrame(rafId);
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('blur', onBlur);
  }

  function destroy() {
    stop();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  return { start, stop, destroy, options: opts };
}
