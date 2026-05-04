# FinalMySog — Cliente Web

**Equipo Sog** | Sistemas Distribuidos — Taller 4

Este es el servicio de **Cliente Web** del proyecto final. Se encarga de la interfaz de usuario: registro, login y lobby en tiempo real.

---

## Diagrama de Arquitectura

```
┌─────────────────────────────────────────────────────────┐
│                     NAVEGADOR                           │
│                                                         │
│   login.html  ──── POST /register ──►  Auth Service     │
│   login.html  ──── POST /login    ──►  (puerto 4000)    │
│                          │                              │
│                    token JWT                            │
│                          │                              │
│   lobby.html  ──── WS /connect?token=XXX ──► Coordinator│
│                    (players_update)         (puerto 5000)│
└─────────────────────────────────────────────────────────┘
         ▲
         │
   server.js (puerto 3000)
   Sirve login.html y lobby.html
   Expone /config.js con las URLs de entorno
```

Los tres servicios corren como procesos separados. El cliente no se comunica directamente con el coordinador en HTTP, solo por WebSocket una vez autenticado.

---

## Estructura del proyecto

```
client/
├── login.html       ← Formularios de registro e inicio de sesión
├── lobby.html       ← Lista de jugadores en línea en tiempo real
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

Copia `.env.example` y ajusta los valores:

```bash
cp .env.example .env
```

Contenido del `.env` para desarrollo local:

```env
PORT=3000
AUTH_SERVICE_URL=http://localhost:4000
COORDINATOR_WS_URL=ws://localhost:5000
```

Cuando uses ngrok, reemplaza con las URLs reales:

```env
PORT=3000
AUTH_SERVICE_URL=https://abc123.ngrok-free.app
COORDINATOR_WS_URL=wss://xyz456.ngrok-free.app
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

---

## Comandos de ngrok

Se abren tres terminales, una por servicio:

```bash
# Terminal 1 — Auth Service
ngrok http 4000

# Terminal 2 — Coordinador
ngrok http 5000

# Terminal 3 — Cliente Web
ngrok http 3000
```

Importante: cuando el cliente está detrás de ngrok (HTTPS), el WebSocket del coordinador debe usar `wss://` en lugar de `ws://`. Actualiza el `.env` con las URLs correctas antes de cada sesión de ngrok.

---

## Decisiones de diseño

### Manejo de doble conexión del mismo usuario

Si el mismo usuario intenta conectarse desde dos pestañas al mismo tiempo, **se rechaza la segunda conexión**. El coordinador detecta que el `userId` ya existe en el Map de jugadores y cierra el nuevo socket con código `4001`.

**Justificación:** mantener una sola sesión activa por usuario simplifica el estado del servidor y evita inconsistencias en el broadcast. Si se permitieran múltiples conexiones, habría que sincronizar el estado entre pestañas y decidir cuándo eliminar al jugador del Map. Rechazar la segunda conexión es más predecible y seguro.

### URLs no hardcodeadas

El servidor Express expone un endpoint `/config.js` que inyecta `window.AUTH_SERVICE_URL` y `window.COORDINATOR_WS_URL` en el cliente. Así los HTML nunca tienen URLs fijas y basta con cambiar el `.env` para apuntar a ngrok o a producción.

### Cierre inesperado del WebSocket

Si el WS se cierra por cualquier razón (token vencido, coordinador caído, red), el cliente muestra un mensaje al usuario, borra el token del `localStorage` y redirige al login automáticamente después de 2.5 segundos.