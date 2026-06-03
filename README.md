# FinalMySog

Proyecto final de **Sistemas Distribuidos**.

Este repositorio implementa un videojuego multijugador distribuido en tiempo real con autenticación, servicios replicados, coordinadores distribuidos, tolerancia a fallos, comunicación HTTP, comunicación WebSocket, JWT, login local, login con Google, modo espectador, chat y sincronización de estado entre procesos.

## Estructura del Proyecto

```text
FinalMySog/
  auth-service/
    Servicio de autenticación.
    Maneja usuarios, JWT, Google login, SQLite, replicación leader/replica
    y directorio de coordinadores disponibles.

  coordinator/
    Servidor autoritativo del juego.
    Maneja WebSockets, jugadores, física, pelota, marcador, equipos,
    chat, espectadores y replicación entre coordinadores.

  client/
    Cliente web.
    Sirve login, lobby, juego, modo espectador y actúa como proxy HTTP
    con failover hacia varios auth-services.
```

## Arquitectura General

```text
Navegador
  |
  | HTTP
  v
client/server.js
  |
  | Proxy con failover
  v
auth-service leader/replica
  |
  | Directorio de coordinadores vivos
  v
coordinator asignado
  |
  | WebSocket
  v
Juego en tiempo real
```

El navegador no llama directamente a los auth-services. Primero entra por el servidor del cliente, que expone rutas `/api/*` y decide a qué auth-service enviar cada solicitud.

El juego se comunica por WebSocket con el coordinador asignado. El coordinador es autoritativo: el cliente no calcula posiciones reales, no decide goles y no modifica el estado global por sí solo. El cliente únicamente envía intenciones de movimiento y renderiza el estado recibido.

## Componentes Principales

## auth-service

El `auth-service` se encarga de la identidad de los usuarios y de mantener una base de datos replicada entre varias instancias.

### Responsabilidades

- Registrar usuarios locales.
- Iniciar sesión con usuario y contraseña.
- Iniciar sesión con Google.
- Validar tokens de Google.
- Emitir JWT.
- Guardar usuarios en SQLite.
- Hashear contraseñas con bcrypt.
- Mantener un log de escrituras.
- Replicar escrituras entre auth-services.
- Elegir un líder si el líder actual cae.
- Sincronizar réplicas atrasadas.
- Recibir heartbeats de coordinadores.
- Mantener un directorio de coordinadores vivos.
- Asignar coordinador a clientes autenticados.
- Asignar coordinador público a espectadores.

### Modelo leader/replica

Cada auth-service puede tener uno de estos roles:

```text
leader
  Acepta lecturas y escrituras.
  Aplica escrituras en su base de datos local.
  Registra las escrituras en write_log.
  Propaga escrituras a las réplicas.
  Envía heartbeats a las réplicas.

replica
  Acepta lecturas si su base de datos está suficientemente actualizada.
  Rechaza escrituras y devuelve la URL del líder.
  Aplica escrituras recibidas desde el líder.
  Pide sincronización si está atrasada.
  Inicia elección si deja de recibir heartbeat del líder.
```

### Base de datos

El servicio crea una base de datos SQLite local.

Tablas principales:

```text
users
  id
  username
  provider
  password_hash
  google_sub
  email
  created_at

write_log
  seq
  op
  data
```

`users` guarda los usuarios registrados.  
`write_log` guarda las escrituras aplicadas para poder sincronizar réplicas atrasadas.

### Endpoints

```text
GET  /health
GET  /status
GET  /peers
POST /register
POST /login
POST /auth/google
POST /heartbeat
GET  /coordinator
GET  /coordinator-public
```

### GET /health

Sirve para verificar que el proceso está vivo.

Respuesta general:

```json
{
  "status": "ok",
  "service": "auth-service",
  "role": "leader",
  "authId": "auth-id"
}
```

### GET /status

Devuelve información interna del nodo auth.

```json
{
  "authId": "auth-id",
  "role": "leader",
  "publicUrl": "AUTH_PUBLIC_URL",
  "peerUrl": "AUTH_PEER_URL",
  "leaderUrl": "CURRENT_LEADER_URL",
  "knownPeers": ["auth-b", "auth-c"],
  "lastAppliedSeq": 0,
  "users": 0
}
```

Este endpoint es útil para revisar:

- Qué auth-service es líder.
- Qué auth-services son réplicas.
- Cuántos usuarios existen en la base local.
- Qué tan actualizado está un nodo.
- Si una réplica sincronizó después de volver a conectarse.

### POST /register

Registra un usuario local.

Body:

```json
{
  "username": "usuario",
  "password": "password"
}
```

Si el nodo es líder:

1. Valida el username.
2. Valida la contraseña.
3. Calcula el hash con bcrypt.
4. Inserta el usuario en SQLite.
5. Registra la operación en `write_log`.
6. Propaga la escritura a las réplicas.
7. Responde con el usuario creado.

Respuesta:

```json
{
  "userId": 1,
  "username": "usuario"
}
```

Si el nodo es réplica y la operación requiere escritura:

```json
{
  "error": "not_leader",
  "leaderUrl": "CURRENT_LEADER_URL"
}
```

### POST /login

Inicia sesión con usuario y contraseña.

Body:

```json
{
  "username": "usuario",
  "password": "password"
}
```

Si las credenciales son correctas:

```json
{
  "token": "JWT",
  "username": "usuario"
}
```

El JWT contiene información básica del usuario:

```json
{
  "userId": 1,
  "username": "usuario",
  "provider": "local"
}
```

Las réplicas pueden responder lecturas si están suficientemente actualizadas. Si están muy atrasadas o no conocen líder, devuelven error para que el cliente reintente contra el líder.

### POST /auth/google

Permite login con Google.

Body para usuario existente:

```json
{
  "idToken": "GOOGLE_ID_TOKEN"
}
```

Si es el primer ingreso con Google, el servicio puede pedir username:

```json
{
  "error": "username_required",
  "hint": "Es tu primer ingreso con Google. Elige un username."
}
```

Body para completar primer ingreso:

```json
{
  "idToken": "GOOGLE_ID_TOKEN",
  "username": "usuario"
}
```

### POST /heartbeat

Lo usan los coordinadores para anunciar que están vivos.

Body:

```json
{
  "coordinatorId": "coordinator-id",
  "publicUrl": "COORDINATOR_PUBLIC_URL",
  "peerUrl": "COORDINATOR_PEER_URL",
  "connectedPlayers": 0,
  "uptime": 0
}
```

El auth-service guarda temporalmente los coordinadores vivos y elimina los que dejan de reportarse.

### GET /coordinator

Devuelve un coordinador disponible para un jugador autenticado.

Requiere header:

```text
Authorization: Bearer <JWT>
```

Respuesta:

```json
{
  "coordinatorId": "coordinator-id",
  "publicUrl": "COORDINATOR_PUBLIC_URL"
}
```

La selección prioriza coordinadores vivos con menor cantidad de jugadores conectados.

### GET /coordinator-public

Devuelve un coordinador disponible para modo espectador.

No requiere JWT.

Respuesta:

```json
{
  "coordinatorId": "coordinator-id",
  "publicUrl": "COORDINATOR_PUBLIC_URL"
}
```

## coordinator

El `coordinator` es el servidor autoritativo del juego. Mantiene el estado real del mundo y lo transmite a jugadores, espectadores y otros coordinadores.

### Responsabilidades

- Validar JWT al conectar jugadores.
- Aceptar jugadores por WebSocket.
- Aceptar espectadores por WebSocket.
- Conectarse a otros coordinadores.
- Mantener jugadores locales y remotos.
- Replicar jugadores conectados.
- Replicar posiciones.
- Replicar intenciones de movimiento.
- Replicar equipos y datos extra.
- Replicar pelota.
- Replicar marcador.
- Replicar estado del partido.
- Replicar chat.
- Ejecutar el loop del juego.
- Procesar movimiento.
- Resolver colisiones entre jugadores.
- Resolver colisiones con la pelota.
- Detectar goles.
- Aplicar penalizaciones de vida.
- Eliminar jugadores sin vida.
- Manejar tiempos del partido.
- Manejar entretiempo.
- Manejar ganador.
- Manejar votación de reinicio.
- Enviar heartbeats a los auth-services.

### Rutas HTTP

```text
GET /health
GET /peers
```

### GET /health

Devuelve el estado general del coordinador.

```json
{
  "status": "ok",
  "coordinatorId": "coordinator-id",
  "localPlayers": 0,
  "spectators": 0,
  "totalPlayers": 0,
  "peers": [],
  "score": {
    "red": 0,
    "blue": 0
  },
  "match": {
    "status": "waiting"
  },
  "uptime": 0
}
```

### WebSockets

```text
/connect
  Conexión de jugadores autenticados.
  Requiere token JWT como query param.

/spectator
  Conexión pública para espectadores.
  No requiere token.

/peer
  Conexión entre coordinadores.
  Se usa para replicar estado.
```

### Conexión de Jugador

El cliente se conecta a:

```text
COORDINATOR_PUBLIC_URL/connect?token=<JWT>
```

El coordinador:

1. Extrae el token.
2. Verifica el JWT usando `JWT_SECRET`.
3. Obtiene `userId` y `username`.
4. Crea el jugador local.
5. Envía mensaje `welcome`.
6. Envía historial de chat.
7. Replica el nuevo jugador a otros coordinadores.
8. Empieza a enviar estados.

Mensaje `welcome`:

```json
{
  "type": "welcome",
  "you": {
    "userId": "user-id",
    "username": "usuario"
  },
  "coordinatorId": "coordinator-id",
  "world": {
    "width": 0,
    "height": 0,
    "playerRadius": 0,
    "tickRate": 0
  }
}
```

### Conexión de Espectador

El espectador se conecta a:

```text
COORDINATOR_PUBLIC_URL/spectator
```

El espectador:

- No necesita JWT.
- No puede mover jugadores.
- No puede cambiar equipo.
- No puede enviar intenciones.
- Solo recibe el estado del juego y el chat.

### Estado del Juego

El coordinador envía mensajes `state` con la forma:

```json
{
  "type": "state",
  "t": 0,
  "players": [
    {
      "userId": "user-id",
      "username": "usuario",
      "x": 0,
      "y": 0,
      "extras": {
        "team": "red",
        "hp": 100,
        "maxHp": 100,
        "eliminated": false
      },
      "ping": 0
    }
  ],
  "ball": {
    "x": 0,
    "y": 0,
    "vx": 0,
    "vy": 0,
    "radius": 0
  },
  "score": {
    "red": 0,
    "blue": 0
  },
  "match": {
    "status": "waiting",
    "half": 0,
    "timeLeft": 0,
    "teamSelectionLocked": false,
    "winner": null
  },
  "zones": [],
  "items": []
}
```

### Movimiento

El cliente no envía coordenadas. Envía intenciones.

```json
{
  "type": "intent",
  "intent": {
    "type": "move",
    "dir": {
      "x": 1,
      "y": 0
    }
  }
}
```

El coordinador recibe la intención y calcula la posición en el loop del juego.

Direcciones válidas:

```text
x = -1 izquierda
x =  1 derecha
y = -1 arriba
y =  1 abajo
```

### Equipos

Los jugadores pueden elegir equipo antes de que el partido bloquee la selección.

Mensaje del cliente:

```json
{
  "type": "extras_update",
  "extras": {
    "team": "red"
  }
}
```

Equipos:

```text
red
blue
```

El coordinador guarda el equipo en `extras.team` y replica el cambio.

### Partido

Estados principales:

```text
waiting
team_selection
playing
halftime
finished
```

Flujo:

1. El partido inicia en `waiting`.
2. Cuando hay jugadores suficientes, se puede enviar `start_match`.
3. Entra a `team_selection`.
4. Los jugadores eligen equipo.
5. Se bloquean los equipos.
6. El partido pasa a `playing`.
7. Se juega el primer tiempo.
8. Entra a `halftime`.
9. Inicia el segundo tiempo.
10. Termina por tiempo o por límite de goles.
11. Se puede reiniciar mediante votación.

Mensaje para iniciar:

```json
{
  "type": "start_match"
}
```

### Pelota y Goles

El coordinador mantiene una pelota con posición y velocidad.

```json
{
  "x": 0,
  "y": 0,
  "vx": 0,
  "vy": 0,
  "radius": 0
}
```

La pelota:

- Rebota contra paredes.
- Tiene fricción.
- Cambia velocidad al chocar con jugadores.
- Genera gol si entra en el arco.
- Actualiza el marcador.
- Se replica a otros coordinadores.

### Vida y Eliminación

Cada jugador tiene vida en `extras.hp`.

```json
{
  "hp": 100,
  "maxHp": 100,
  "eliminated": false
}
```

Cuando un equipo recibe gol, sus jugadores pierden vida. Si un jugador llega a cero, queda eliminado.

### Chat

El coordinador mantiene historial limitado de chat y lo replica entre coordinadores.

Mensaje enviado por cliente:

```json
{
  "type": "chat",
  "text": "hola"
}
```

Mensaje enviado por servidor:

```json
{
  "type": "chat_message",
  "message": {
    "username": "usuario",
    "text": "hola",
    "ts": 0
  }
}
```

Historial:

```json
{
  "type": "chat_history",
  "messages": []
}
```

### Votación de Reinicio

Un jugador con equipo puede pedir reiniciar el partido.

Solicitud:

```json
{
  "type": "restart_vote_request"
}
```

El coordinador crea una votación para todos los jugadores conectados que tengan equipo.

Mensaje de votación:

```json
{
  "type": "restart_vote_request",
  "voteId": "vote-id",
  "requestedBy": "usuario",
  "accepted": 1,
  "total": 2
}
```

Respuesta del jugador:

```json
{
  "type": "restart_vote_response",
  "voteId": "vote-id",
  "accepted": true
}
```

Si todos aceptan:

```json
{
  "type": "restart_vote_approved",
  "voteId": "vote-id",
  "message": "Todos aceptaron. Reiniciando partido..."
}
```

Si alguien rechaza:

```json
{
  "type": "restart_vote_rejected",
  "voteId": "vote-id",
  "message": "No se reinició el partido."
}
```

Al reiniciar se limpian:

- Marcador.
- Pelota.
- Ganador.
- Equipos.
- Vida.
- Eliminaciones.
- Estado del partido.
- Intenciones de movimiento.

## client

El `client` contiene el frontend web y un servidor Express que funciona como proxy hacia los auth-services.

### Responsabilidades

- Servir páginas HTML.
- Servir `game.js`.
- Exponer `/config.js`.
- Exponer rutas `/api/*`.
- Leer configuración pública desde variables de entorno.
- Probar varios auth-services.
- Reintentar si hay error de red.
- Reintentar si hay respuesta 5xx.
- Reintentar contra el líder si recibe `not_leader`.
- Guardar JWT en `localStorage`.
- Solicitar coordinador disponible.
- Conectarse por WebSocket al coordinador.
- Reconectar si el coordinador cae.
- Renderizar el juego en canvas.
- Mostrar jugadores conectados.
- Mostrar marcador.
- Mostrar estado del partido.
- Mostrar ping.
- Mostrar auth activo.
- Mostrar coordinador activo.
- Manejar chat.
- Manejar selección de equipo.
- Manejar votación de reinicio.
- Manejar modo espectador.

### Archivos

```text
login.html
  Pantalla de registro, login local y login con Google.

lobby.html
  Pantalla de lobby con jugadores conectados y coordinador asignado.

game.html
  Pantalla principal del juego.

spectator.html
  Pantalla pública de espectador.

game.js
  Módulo de renderizado del juego y captura de input.

server.js
  Servidor Express del cliente y proxy con failover hacia auth-services.
```

### Rutas del Cliente

```text
GET  /
GET  /config.js
GET  /api/auth/status
POST /api/register
POST /api/login
POST /api/auth/google
GET  /api/coordinator
GET  /api/coordinator-public
```

### /config.js

Expone configuración pública al navegador.

Variables generadas:

```js
window.API_BASE_URL
window.COORDINATOR_WS_URL
window.GOOGLE_CLIENT_ID
window.AUTH_URLS
window.AUTH_ACTIVE_URL
window.SPECTATOR_WS_PATH
```

### Failover de Auth

El cliente usa una lista de auth-services.

Flujo:

1. Intenta con el auth activo.
2. Si falla por red, prueba otro.
3. Si responde con error 5xx, prueba otro.
4. Si responde `not_leader`, toma `leaderUrl`.
5. Repite el request contra el líder.
6. Si funciona, actualiza el auth activo.

Esto aplica para:

```text
/api/register
/api/login
/api/auth/google
/api/coordinator
```

### Login Local

El navegador llama:

```text
POST /api/login
```

Si el login funciona:

1. Guarda `token` en `localStorage`.
2. Guarda `username` en `localStorage`.
3. Redirige al juego.

### Registro Local

El navegador llama:

```text
POST /api/register
```

Si el registro funciona, el usuario puede iniciar sesión.

### Login con Google

El navegador usa Google Identity Services para obtener un `idToken`.

Luego llama:

```text
POST /api/auth/google
```

Si el usuario entra por primera vez con Google, se muestra un modal para elegir username.

### Juego

`game.html`:

1. Lee el token.
2. Pide coordinador con `/api/coordinator`.
3. Abre WebSocket con el coordinador.
4. Recibe `welcome`.
5. Inicializa `game.js`.
6. Envía intenciones de movimiento.
7. Recibe estados.
8. Renderiza canvas.
9. Actualiza marcador, jugadores, chat, ping y estado del partido.

### Renderizado

`game.js` se encarga de:

- Crear el canvas.
- Capturar teclado.
- Enviar intenciones cuando cambia la dirección.
- Dibujar fondo.
- Dibujar campo.
- Dibujar jugadores.
- Dibujar nombres.
- Dibujar vida.
- Dibujar pelota.
- Dibujar zonas e items si existen.
- Resaltar jugador local.
- Mantener loop de render con `requestAnimationFrame`.

Controles:

```text
WASD
Flechas
```

### Modo Espectador

`spectator.html`:

- No requiere token.
- Pide coordinador público.
- Se conecta a `/spectator`.
- Inicializa `game.js` con input desactivado.
- Solo renderiza estado recibido.
- Muestra marcador y chat.
- Permite ingresar URL manual si no encuentra coordinador.

## Variables de Entorno

No se deben subir valores reales de `.env` al repositorio.  
Cada carpeta debe tener su propio `.env` local basado en `.env.example`.

### auth-service

```env
PORT=<AUTH_PORT>
AUTH_ID=<AUTH_ID>
PUBLIC_URL=<AUTH_PUBLIC_HTTP_URL>
PEER_URL=<AUTH_PEER_WS_URL>
PEER_URLS=<OTHER_AUTH_PEER_WS_URLS>

JWT_SECRET=<SHARED_LONG_JWT_SECRET>
JWT_EXPIRES_IN=<JWT_EXPIRATION>
BCRYPT_ROUNDS=<BCRYPT_ROUNDS>
GOOGLE_CLIENT_ID=<GOOGLE_CLIENT_ID>
CORS_ORIGINS=<ALLOWED_ORIGINS>
```

### coordinator

```env
PORT=<COORDINATOR_PORT>
COORDINATOR_ID=<COORDINATOR_ID>
PUBLIC_URL=<COORDINATOR_PUBLIC_WS_URL>
PEER_URL=<COORDINATOR_PEER_WS_URL>

JWT_SECRET=<SAME_SHARED_JWT_SECRET>
AUTH_URLS=<AUTH_SERVICE_HTTP_URLS>
TICK_RATE=<GAME_TICK_RATE>
```

### client

```env
PORT=<CLIENT_PORT>
AUTH_URLS=<AUTH_SERVICE_HTTP_URLS>
COORDINATOR_WS_URL=<OPTIONAL_COORDINATOR_WS_FALLBACK>
SPECTATOR_WS_PATH=<SPECTATOR_WS_PATH>
GOOGLE_CLIENT_ID=<GOOGLE_CLIENT_ID>
```

Importante:

```text
JWT_SECRET debe ser igual en auth-service y coordinator.
GOOGLE_CLIENT_ID debe coincidir con el configurado en Google Cloud.
AUTH_URLS debe contener las URLs públicas HTTP de los auth-services.
PUBLIC_URL y PEER_URL deben ser accesibles desde los otros procesos que las usan.
```

## Instalación

Instalar dependencias en cada carpeta.

```bash
cd auth-service
npm install
```

```bash
cd coordinator
npm install
```

```bash
cd client
npm install
```

## Ejecución

Crear un archivo `.env` en cada carpeta.

Ejecutar auth-service:

```bash
cd auth-service
npm start
```

Ejecutar coordinator:

```bash
cd coordinator
npm start
```

Ejecutar client:

```bash
cd client
npm start
```

Para una ejecución distribuida se levantan varias instancias de `auth-service` y varias instancias de `coordinator`, cada una con IDs y URLs diferentes.

## Flujo Completo

### Registro de Usuario

```text
Usuario
  -> client
  -> /api/register
  -> auth-service disponible
  -> leader si hace falta
  -> SQLite
  -> write_log
  -> réplicas
```

Pasos:

1. El usuario llena el formulario.
2. El cliente llama `/api/register`.
3. El proxy intenta auth-services disponibles.
4. Si llega a una réplica, reintenta contra el líder.
5. El líder registra el usuario.
6. El líder propaga la escritura.
7. Las réplicas aplican el cambio.

### Login

```text
Usuario
  -> client
  -> /api/login
  -> auth-service
  -> JWT
  -> localStorage
```

Pasos:

1. El usuario envía credenciales.
2. Auth busca el usuario.
3. Auth compara contraseña con bcrypt.
4. Auth emite JWT.
5. Cliente guarda token.
6. Cliente entra al juego.

### Asignación de Coordinador

```text
Cliente autenticado
  -> /api/coordinator
  -> auth-service
  -> coordinador vivo con menor carga
  -> publicUrl
```

Pasos:

1. Cliente envía JWT.
2. Auth valida JWT.
3. Auth revisa coordinadores vivos.
4. Auth escoge uno disponible.
5. Cliente recibe `coordinatorId` y `publicUrl`.

### Conexión al Juego

```text
Cliente
  -> WebSocket /connect?token=<JWT>
  -> coordinator
  -> welcome
  -> state
```

Pasos:

1. Cliente abre WebSocket.
2. Coordinador verifica JWT.
3. Coordinador crea jugador.
4. Coordinador envía `welcome`.
5. Coordinador empieza a transmitir `state`.
6. Cliente renderiza el juego.

### Movimiento en Tiempo Real

```text
Teclado
  -> intent
  -> coordinator
  -> cálculo autoritativo
  -> state
  -> render
```

Pasos:

1. El jugador presiona teclas.
2. `game.js` calcula dirección.
3. Cliente envía `intent`.
4. Coordinador actualiza intención.
5. Loop del coordinador mueve jugador.
6. Coordinador emite nuevo estado.
7. Cliente dibuja el estado.

### Reconexión

Si el coordinador se cae:

1. El WebSocket se cierra.
2. El cliente muestra aviso.
3. El cliente pide otro coordinador.
4. El auth-service devuelve uno vivo.
5. El cliente abre nuevo WebSocket.
6. El juego continúa usando el JWT existente.

## Replicación de Auth

Los auth-services se conectan entre sí por WebSocket y usan mensajes JSON.

### hello

```json
{
  "type": "hello",
  "authId": "auth-id",
  "role": "leader",
  "term": 0,
  "lastSeq": 0
}
```

### heartbeat

```json
{
  "type": "heartbeat",
  "authId": "auth-id",
  "term": 0,
  "lastSeq": 0
}
```

### write_propagate

```json
{
  "type": "write_propagate",
  "term": 0,
  "seq": 0,
  "op": "register",
  "data": {}
}
```

Operaciones principales:

```text
register
register_google
```

### request_sync

```json
{
  "type": "request_sync",
  "fromSeq": 0
}
```

### sync_response

```json
{
  "type": "sync_response",
  "entries": [
    {
      "seq": 0,
      "op": "register",
      "data": {}
    }
  ]
}
```

### election

```json
{
  "type": "election",
  "candidate": "auth-id",
  "term": 0,
  "lastSeq": 0
}
```

### vote

```json
{
  "type": "vote",
  "voter": "auth-id",
  "term": 0,
  "voteGranted": true
}
```

### new_leader

```json
{
  "type": "new_leader",
  "leader": "auth-id",
  "term": 0,
  "leaderUrl": "AUTH_PUBLIC_URL"
}
```

## Replicación de Coordinadores

Los coordinadores forman un mesh usando WebSocket en `/peer`.

Mensajes principales:

```text
hello
player_joined
player_left
intent_replicate
extras_replicate
positions_replicate
players_replicate
ball_replicate
score_replicate
match_replicate
chat_replicate
chat_history_replicate
start_match_replicate
restart_match_replicate
restart_vote_request_replicate
restart_vote_update_replicate
restart_vote_cancel_replicate
restart_vote_approved_replicate
```

Esto permite que jugadores conectados a coordinadores distintos puedan verse dentro del mismo mundo distribuido.

## Modelo de Consistencia

El sistema usa un modelo de escritor único.

```text
Solo el líder acepta escrituras.
Las réplicas aplican los cambios que reciben del líder.
Si el líder cae, se elige un nuevo líder.
```

La escritura se aplica primero en el líder y luego se propaga a las réplicas.

Ventajas:

- Menor latencia.
- Implementación más simple.
- Buen rendimiento para el flujo de login y registro.
- Evita que dos nodos acepten escrituras conflictivas al mismo tiempo.

Consideración:

- Una escritura muy reciente podría tardar un poco en aparecer en todas las réplicas.
- Durante una elección puede haber unos segundos donde no se acepten escrituras.
- El cliente y el proxy deben reintentar cuando reciban errores temporales.

## Seguridad

El sistema incluye:

- JWT para sesión de usuarios.
- Contraseñas hasheadas con bcrypt.
- Validación de username.
- Validación de Google ID Token.
- CORS configurable.
- Verificación de JWT antes de aceptar jugadores.
- Separación entre jugadores autenticados y espectadores.
- Límite de tamaño para JSON entrante.
- Rate limiting básico para chat.
- Rechazo de escrituras en réplicas.

## Notas de Operación

Para que el sistema funcione correctamente:

- Todas las instancias deben compartir el mismo `JWT_SECRET`.
- Cada auth-service debe tener un `AUTH_ID` único.
- Cada coordinator debe tener un `COORDINATOR_ID` único.
- Las URLs públicas deben ser accesibles desde los clientes y servicios que las consumen.
- Las URLs peer deben ser accesibles entre procesos del mismo grupo.
- Los auth-services deben conocer a sus peers.
- Los coordinadores deben conocer la lista de auth-services.
- El cliente debe conocer la lista de auth-services.
- No se deben subir archivos `.env` con secretos reales.

## Prueba Manual Recomendada

1. Levantar varias instancias de auth-service.
2. Revisar `/status` en cada auth-service.
3. Confirmar que existe un líder.
4. Levantar varias instancias de coordinator.
5. Confirmar que los coordinadores envían heartbeats.
6. Levantar el cliente web.
7. Registrar un usuario.
8. Iniciar sesión.
9. Entrar al juego.
10. Conectar otro usuario.
11. Iniciar partida.
12. Elegir equipos.
13. Mover jugadores.
14. Verificar pelota, marcador y chat.
15. Abrir modo espectador.
16. Detener un coordinador y verificar reconexión.
17. Detener el auth líder y verificar que otro auth tome liderazgo.
18. Registrar o iniciar sesión después del cambio de líder.
19. Volver a levantar el auth detenido y revisar que sincronice.

## Resumen

FinalMySog es una aplicación distribuida compuesta por tres capas:

```text
auth-service
  Identidad, JWT, usuarios, Google login, replicación y directorio.

coordinator
  Estado autoritativo del juego, WebSockets, física y replicación de partida.

client
  Interfaz web, proxy con failover, renderizado, reconexión y modo espectador.
```

El sistema permite que varios jugadores entren, se autentiquen, sean asignados a coordinadores disponibles y jueguen en tiempo real dentro de un entorno distribuido con tolerancia a fallos.
