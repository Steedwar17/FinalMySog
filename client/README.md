# FinalMySog - Cliente Web

**Equipo Sog** | Sistemas Distribuidos - Taller 7

Este es el servicio de **Cliente Web** del proyecto final. Se encarga de la interfaz de usuario: registro, login con usuario/contrasena o Google, lobby, pantalla del juego en tiempo real con canvas, feature extra de equipos (Rojos vs Azules) y failover entre auth-services replicados.

---

## Arquitectura

```text
Navegador
  login.html  -> POST /api/register     -> server.js -> Auth leader/replica disponible
  login.html  -> POST /api/login        -> server.js -> Auth leader/replica disponible
  login.html  -> POST /api/auth/google  -> server.js -> Auth leader/replica disponible

  game.html/lobby.html
    1. Lee API_BASE_URL desde /config.js
    2. Hace GET /api/coordinator al server.js del cliente
    3. server.js prueba los AUTH_URLS hasta encontrar un auth disponible
    4. Si recibe 503 not_leader, reintenta contra leaderUrl
    5. Devuelve { coordinatorId, publicUrl }
    6. Abre WS publicUrl/connect?token=JWT
    7. Muestra en pantalla el coordinador y auth usados

server.js
  Sirve login.html, lobby.html, game.html y game.js
  Expone /config.js con las variables publicas del cliente
  Expone /api/* como puente con failover hacia los Auth Services
```

El cliente no calcula posiciones. Solo manda intenciones de movimiento al coordinador asignado y renderiza el estado que recibe.

---

## Estructura

```text
client/
  login.html       Registro, login local y login con Google
  lobby.html       Lista de jugadores en linea y coordinador asignado
  game.html        Canvas del juego, conexion WS, reconexion y equipos
  spectator.html   Vista publica de solo lectura para spectator mode
  game.js          Renderizado y captura de input
  server.js        Servidor Express del cliente
  package.json
  .env             Variables locales
  .env.example     Plantilla de variables
  README.md
```

---

## Como correr

```bash
cd client
npm install
cp .env.example .env
npm start
```

El cliente queda disponible en `http://localhost:3000`.

Para desarrollo local:

```env
PORT=3000
AUTH_URLS=http://localhost:4001,http://localhost:4002,http://localhost:4003
COORDINATOR_WS_URL=
SPECTATOR_WS_PATH=/spectator
GOOGLE_CLIENT_ID=<tu-client-id>.apps.googleusercontent.com
```

`AUTH_URLS` lo usa solo `server.js`. El navegador llama al mismo origen del cliente por `/api/*`, y el servidor del cliente decide a que auth pegarle.

Por compatibilidad, si existe `AUTH_SERVICE_URL` y no existe `AUTH_URLS`, el cliente todavia puede arrancar con un solo auth. Para Taller 7 se debe usar `AUTH_URLS`.

`COORDINATOR_WS_URL` es opcional y queda solo como fallback local. Desde Taller 6, y tambien en Taller 7, el flujo principal es pedir el coordinador por `GET /api/coordinator`.
Para Taller 5 o pruebas sin directorio de coordinadores, se puede usar `COORDINATOR_WS_URL=ws://localhost:5001`.

Con ngrok:

```env
PORT=3000
AUTH_URLS=https://auth-a.ngrok-free.app,https://auth-b.ngrok-free.app,https://auth-c.ngrok-free.app
COORDINATOR_WS_URL=
GOOGLE_CLIENT_ID=<tu-client-id>.apps.googleusercontent.com
```

El `publicUrl` que devuelva `/coordinator` puede venir como `http`, `https`, `ws` o `wss`; el cliente lo normaliza a WebSocket antes de conectarse.

---

## Flujo de Taller 7

### Auth failover

Todas las llamadas del navegador a `/api/*` pasan por `server.js`. El proxy intenta cada URL de `AUTH_URLS` en orden.

Si hay error de red o una respuesta `5xx`, intenta con el siguiente auth. Si recibe `503` con `{ "error": "not_leader", "leaderUrl": "..." }`, repite el mismo request directamente contra `leaderUrl`.

El proxy agrega estos headers a la respuesta para que la UI pueda mostrar que auth atendio:

```http
X-Auth-Url: https://auth-b.ngrok-free.app
X-Auth-Attempts: https://auth-a.ngrok-free.app,https://auth-b.ngrok-free.app
```

`login.html`, `lobby.html` y `game.html` muestran el auth activo en pantalla.

### Descubrimiento de coordinador

Despues de iniciar sesion, `game.html` y `lobby.html` llaman:

```http
GET /api/coordinator
Authorization: Bearer <token>
```

Respuesta esperada:

```json
{
  "coordinatorId": "coordA",
  "publicUrl": "wss://coord-a.ngrok-free.app"
}
```

Luego el cliente abre:

```text
wss://coord-a.ngrok-free.app/connect?token=<token>
```

### Reconexion

Si se cae el WebSocket por red o por caida del coordinador, el cliente no borra la sesion de inmediato. Muestra un aviso, vuelve a pedir `/api/coordinator` y se conecta al coordinador vivo que responda el directorio.

Si el coordinador cierra con codigo `4001`, se trata como token invalido o vencido: el cliente borra la sesion local y vuelve al login.

### Indicador visual

La pantalla de juego y el lobby muestran el `coordinatorId` al que quedo conectada la pestana. Esto sirve para sustentar que Alice y Bob pueden estar conectados a coordinadores distintos y verse en vivo.

---

## Login y Google

El login local usa:

```text
POST /api/register
POST /api/login
```

El login con Google usa Google Identity Services en el navegador y envia el ID token al Auth Service:

```text
POST /api/auth/google
```

Si es el primer acceso con Google, el cliente pide un username y reintenta el mismo endpoint con ese dato.

---

## Juego

El cliente envia intents al coordinador:

```json
{
  "type": "intent",
  "intent": {
    "type": "move",
    "dir": { "x": 1, "y": 0 }
  }
}
```

El servidor sigue siendo autoritativo: calcula posiciones, replica el estado y envia los mensajes `welcome`, `state`, `players_update` y `pong`.

La feature extra de equipos envia:

```json
{
  "type": "extras_update",
  "extras": { "team": "red" }
}
```

El cliente pinta cada jugador con el color de su equipo y mantiene el marcador visual de rojos y azules.

Para el examen final, `game.js` tambien renderiza estado autoritativo adicional si el coordinador lo envia:

```json
{
  "type": "state",
  "players": [],
  "ball": { "x": 400, "y": 300, "radius": 12 },
  "score": { "red": 1, "blue": 0 },
  "match": { "status": "playing", "timeLeft": 120 }
}
```

El cliente no calcula goles, colisiones, comida, vida ni fin de partida. Solo dibuja `ball`, `score`, `match`, `zones`, `items`, `food` o `points` cuando llegan dentro del `state` replicado por el coordinador.

--- 

## Reinicio de partido

`game.html` incluye un boton **Reiniciar partido**. El boton solo se muestra si el cliente recibe en el `state` que el jugador local tiene equipo (`extras.team = "red"` o `"blue"`) y el partido ya fue iniciado o terminado. Durante `waiting`, seleccion inicial o antes de presionar **Jugar**, el boton permanece oculto.

Para que el boton aparezca correctamente, el coordinador debe guardar y reenviar el equipo despues de este mensaje:

```json
{
  "type": "extras_update",
  "extras": { "team": "red" }
}
```

El `state` esperado para cada jugador debe conservar el equipo:

```json
{
  "userId": "user-1",
  "username": "Sog",
  "extras": {
    "team": "red"
  }
}
```

Tambien se espera que el coordinador envie un estado de partido claro:

```json
{
  "match": {
    "status": "waiting",
    "teamSelectionLocked": false
  }
}
```

Estados como `waiting`, `prestart`, `team_selection` o `countdown` habilitan la seleccion de equipo. Estados como `playing`, `running`, `in_progress`, `halftime`, `finished` o `final` bloquean la seleccion y permiten mostrar el boton de reinicio a jugadores con equipo.

Cuando el jugador pide reiniciar, el cliente envia:

```json
{
  "type": "restart_vote_request",
  "requestedAt": 1710000000000
}
```

El coordinador debe abrir una votacion con `voteId`. Solo deben votar jugadores conectados con equipo `red` o `blue`; espectadores y jugadores sin equipo no cuentan. Todos los jugadores con equipo deben aceptar.

Mensajes que el cliente entiende:

```json
{ "type": "restart_vote_request", "voteId": "abc", "requestedBy": "Sog", "accepted": 1, "total": 3 }
{ "type": "restart_vote_update", "voteId": "abc", "accepted": 2, "total": 3 }
{ "type": "restart_vote_rejected", "voteId": "abc", "message": "No se reinicio el partido." }
{ "type": "restart_vote_cancelled", "voteId": "abc", "message": "Votacion cancelada." }
{ "type": "restart_vote_approved", "voteId": "abc", "message": "Todos aceptaron. Reiniciando partido..." }
```

Para responder una votacion, el cliente envia:

```json
{
  "type": "restart_vote_response",
  "voteId": "abc",
  "accepted": true,
  "respondedAt": 1710000000000
}
```

Cuando todos acepten, el coordinador debe reiniciar marcador, ganador, posiciones y estado del mundo; volver a `match.status = "waiting"`; poner `teamSelectionLocked = false`; limpiar `extras.team` y estados de eliminado para que todos puedan escoger equipo otra vez; y emitir un `state` actualizado.

Los avisos rojos de `game.html` se ocultan automaticamente despues de 3 segundos.

--- 

## Spectator mode

La vista publica esta en:

```text
http://localhost:3000/spectator.html
```

No requiere token local y se conecta al coordinador con `SPECTATOR_WS_PATH` (`/spectator` por defecto). Si el directorio publico no esta disponible, usa `COORDINATOR_WS_URL` como fallback. Esta pantalla llama a `createGame` con `inputEnabled: false`, por lo que no registra controles ni envia `intent` o `extras_update`.

--- 

## Chat distribuido

`game.html` soporta mensajes WS:

```json
{ "type": "chat", "text": "hola" }
{ "type": "chat_message", "message": { "username": "alice", "text": "hola" } }
{ "type": "chat_history", "messages": [] }
```

El cliente limita visualmente los mensajes a 160 caracteres y escapa HTML antes de pintarlos. El orden, rate limiting, persistencia de los ultimos mensajes y replicacion entre coordinadores siguen siendo responsabilidad del coordinador.
