# FinalMySog — Cliente Web

**Equipo Sog** | Sistemas Distribuidos — Taller 4 y 5

Este es el servicio de **Cliente Web** del proyecto final. Se encarga de la interfaz de usuario: registro, login con usuario/contraseña o Google, pantalla del juego en tiempo real con canvas, y feature extra de equipos (Rojos vs Azules).

---

## Diagrama de Arquitectura

```
┌─────────────────────────────────────────────────────────────┐
│                        NAVEGADOR                            │
│                                                             │
│   login.html  ──── POST /register      ──►  Auth Service   │
│   login.html  ──── POST /login         ──►  (puerto 4000)  │
│   login.html  ──── POST /auth/google   ──►                  │
│                          │                                  │
│                    token JWT                                │
│                          │                                  │
│   game.html   ──── WS /connect?token=XXX ──► Coordinator   │
│                    (welcome, state,          (puerto 5001)  │
│                     intent, extras_update)                  │
└─────────────────────────────────────────────────────────────┘
         ▲
         │
   server.js (puerto 3000)
   Sirve login.html, lobby.html, game.html, game.js
   Expone /config.js con las URLs de entorno
```

Los tres servicios corren como procesos separados. El cliente no calcula posiciones — solo manda intenciones de movimiento al coordinador y renderiza el estado que recibe.

---

## Estructura del proyecto

```
client/
├── login.html       ← Registro, login local y login con Google (Opción A)
├── lobby.html       ← Lista de jugadores en línea en tiempo real
├── game.html        ← Canvas del juego, feature extra de equipos
├── game.js          ← Módulo de renderizado y captura de input (provisto por el taller)
├── server.js        ← Servidor Express (puerto 3000)
├── package.json
├── .env             ← Variables de entorno locales (no se versiona)
├── .env.example     ← Plantilla de variables de entorno
├── .gitignore
└── README.md
```

---

## Cómo correr el servicio

### 1. Instalar dependencias

```bash
cd client
npm install
```

### 2. Crear el archivo `.env`

```bash
cp .env.example .env
```

Contenido del `.env` para desarrollo local:

```env
PORT=3000
AUTH_SERVICE_URL=http://localhost:4000
COORDINATOR_WS_URL=ws://localhost:5001
GOOGLE_CLIENT_ID=<tu-client-id>.apps.googleusercontent.com
```

Cuando uses ngrok, reemplaza con las URLs reales:

```env
PORT=3000
AUTH_SERVICE_URL=https://abc123.ngrok-free.app
COORDINATOR_WS_URL=wss://xyz456.ngrok-free.app
GOOGLE_CLIENT_ID=<tu-client-id>.apps.googleusercontent.com
```

### 3. Iniciar el servidor

```bash
npm start
```

El cliente queda disponible en: `http://localhost:3000`

---

## Ejemplos de curl para Auth Service

### Registrar un usuario

```bash
curl -X POST http://localhost:4000/register \
  -H "Content-Type: application/json" \
  -d '{"username":"alice","password":"secret123"}'
```

Respuesta esperada (`201`):
```json
{ "userId": 1, "username": "alice" }
```

### Iniciar sesión

```bash
curl -X POST http://localhost:4000/login \
  -H "Content-Type: application/json" \
  -d '{"username":"alice","password":"secret123"}'
```

Respuesta esperada (`200`):
```json
{ "token": "eyJhbGc...", "username": "alice" }
```

### Login con Google

```bash
curl -X POST http://localhost:4000/auth/google \
  -H "Content-Type: application/json" \
  -d '{"idToken":"<google-id-token>"}'
```

Primera vez — respuesta esperada (`409`):
```json
{ "error": "username_required", "hint": "Primer login con Google." }
```

Con username — respuesta esperada (`200`):
```json
{ "token": "eyJhbGc...", "username": "bob_google" }
```

---

## Comandos de ngrok

```bash
# Terminal 1 — Auth Service
ngrok http 4000

# Terminal 2 — Coordinador
ngrok http 5001

# Terminal 3 — Cliente Web
ngrok http 3000
```

Cuando el cliente está detrás de ngrok (HTTPS), el WebSocket del coordinador debe usar `wss://` en lugar de `ws://`. Actualiza el `.env` con las URLs correctas antes de cada sesión de ngrok. El `GOOGLE_CLIENT_ID` en Google Cloud Console debe tener registrada la URL de ngrok del cliente en "Authorized JavaScript origins".

---

## Decisiones de diseño

### Login con Google — Opción A (Google Identity Services)

Se eligió la Opción A porque el flujo ocurre completamente en el cliente sin redirecciones. El SDK oficial de Google entrega un ID Token directamente al navegador, que lo envía al auth service via `POST /auth/google`. El servidor lo verifica con `google-auth-library` y emite el JWT propio. Esto evita manejar callbacks de OAuth en el backend y es más simple de desplegar con ngrok.

### Feature extra — Equipos (Rojos vs Azules)

El jugador elige su equipo desde el header de `game.html`. El cliente envía `{ type: 'extras_update', extras: { team: 'red' | 'blue' } }` al coordinador. El coordinador guarda el valor en `player.extras` y lo replica en cada tick del game loop. Todos los demás clientes lo reciben en el mensaje `state` y el círculo del jugador se dibuja con el color de su equipo. Es replicado (todos lo ven) y persistente durante la sesión.

### El servidor es autoritativo

El cliente nunca calcula posiciones. Solo captura teclas WASD/flechas y envía intenciones de movimiento `{ type: 'intent', intent: { type: 'move', dir: { x, y } } }` al coordinador. El coordinador aplica la física, normaliza diagonales con `Math.hypot` y hace broadcast del estado a 20 Hz. `window.lastState` en el cliente es solo para renderizado.

### URLs no hardcodeadas

El servidor Express expone `/config.js` que inyecta `window.AUTH_SERVICE_URL`, `window.COORDINATOR_WS_URL` y `window.GOOGLE_CLIENT_ID` en el cliente. Basta con cambiar el `.env` para apuntar a ngrok o a producción.

### Manejo de doble conexión del mismo usuario

Si el mismo usuario intenta conectarse desde dos pestañas, se rechaza la segunda conexión. El coordinador detecta que el `userId` ya existe en el Map y cierra el nuevo socket con código `4001`. Esto simplifica el estado del servidor y evita inconsistencias en el broadcast.

### Cierre inesperado del WebSocket

Si el WS se cierra por cualquier razón (token vencido, coordinador caído, red), el cliente muestra un mensaje, borra el token del `localStorage` y redirige al login automáticamente después de 2.5 segundos.