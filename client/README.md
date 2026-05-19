# FinalMySog - Cliente Web

**Equipo Sog** | Sistemas Distribuidos - Taller 6

Este es el servicio de **Cliente Web** del proyecto final. Se encarga de la interfaz de usuario: registro, login con usuario/contrasena o Google, lobby, pantalla del juego en tiempo real con canvas y feature extra de equipos (Rojos vs Azules).

---

## Arquitectura

```text
Navegador
  login.html  -> POST /register     -> Auth Service
  login.html  -> POST /login        -> Auth Service
  login.html  -> POST /auth/google  -> Auth Service

  game.html/lobby.html
    1. Lee AUTH_SERVICE_URL desde /config.js
    2. Hace GET /coordinator al Auth Service
    3. Recibe { coordinatorId, publicUrl }
    4. Abre WS publicUrl/connect?token=JWT
    5. Muestra en pantalla el coordinador asignado

server.js
  Sirve login.html, lobby.html, game.html y game.js
  Expone /config.js con las variables de entorno del cliente
```

El cliente no calcula posiciones. Solo manda intenciones de movimiento al coordinador asignado y renderiza el estado que recibe.

---

## Estructura

```text
client/
  login.html       Registro, login local y login con Google
  lobby.html       Lista de jugadores en linea y coordinador asignado
  game.html        Canvas del juego, conexion WS, reconexion y equipos
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
AUTH_SERVICE_URL=http://localhost:4000
COORDINATOR_WS_URL=
GOOGLE_CLIENT_ID=<tu-client-id>.apps.googleusercontent.com
```

`COORDINATOR_WS_URL` es opcional y queda solo como fallback local. En Taller 6 el flujo principal es pedir el coordinador al Auth Service con `GET /coordinator`.

Con ngrok:

```env
PORT=3000
AUTH_SERVICE_URL=https://auth-abc.ngrok-free.app
COORDINATOR_WS_URL=
GOOGLE_CLIENT_ID=<tu-client-id>.apps.googleusercontent.com
```

El `publicUrl` que devuelva `/coordinator` puede venir como `http`, `https`, `ws` o `wss`; el cliente lo normaliza a WebSocket antes de conectarse.

---

## Flujo de Taller 6

### Descubrimiento de coordinador

Despues de iniciar sesion, `game.html` y `lobby.html` llaman:

```http
GET /coordinator
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

Si se cae el WebSocket por red o por caida del coordinador, el cliente no borra la sesion de inmediato. Muestra un aviso, vuelve a pedir `/coordinator` y se conecta al coordinador vivo que responda el directorio.

Si el coordinador cierra con codigo `4001`, se trata como token invalido o vencido: el cliente borra la sesion local y vuelve al login.

### Indicador visual

La pantalla de juego y el lobby muestran el `coordinatorId` al que quedo conectada la pestana. Esto sirve para sustentar que Alice y Bob pueden estar conectados a coordinadores distintos y verse en vivo.

---

## Login y Google

El login local usa:

```text
POST /register
POST /login
```

El login con Google usa Google Identity Services en el navegador y envia el ID token al Auth Service:

```text
POST /auth/google
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
