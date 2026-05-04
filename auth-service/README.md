# auth-service — Taller 4, Sistemas Distribuidos

Servicio de autenticación HTTP (puerto 4000). Registra usuarios, hashea contraseñas con bcrypt y emite tokens JWT firmados que el coordinador valida.

---

## Instalación y arranque

```bash
cd auth-service
npm install
cp .env.example .env
# Edita .env y pon una JWT_SECRET fuerte (la misma que en coordinator/.env)
npm start
```

Para desarrollo con auto-recarga (Node 18+):
```bash
npm run dev
```

---

## Variables de entorno (`.env`)

| Variable     | Descripción                                                         | Ejemplo                  |
|--------------|---------------------------------------------------------------------|--------------------------|
| `PORT`       | Puerto donde escucha el servicio                                    | `4000`                   |
| `JWT_SECRET` | Clave para firmar los JWT. **Debe ser igual en auth y coordinator** | `mi_secreto_muy_largo`   |

Genera un secreto seguro:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## Endpoints

### `GET /health`
Verifica que el servicio esté vivo.

```bash
curl http://localhost:4000/health
# { "status": "ok", "service": "auth-service" }
```

---

### `POST /register`

**Body:** `{ "username": string, "password": string (mín. 6 chars) }`

| Código | Situación                    | Respuesta                          |
|--------|------------------------------|------------------------------------|
| 201    | Registro exitoso             | `{ "userId": 1, "username": "alice" }` |
| 400    | Body inválido                | `{ "error": "..." }`               |
| 409    | Username ya existe           | `{ "error": "El username ya está registrado" }` |
| 500    | Error interno                | `{ "error": "Error interno del servidor" }` |

```bash
curl -X POST http://localhost:4000/register \
  -H "Content-Type: application/json" \
  -d '{"username":"alice","password":"secret123"}'
```

---

### `POST /login`

**Body:** `{ "username": string, "password": string }`

| Código | Situación                     | Respuesta                                      |
|--------|-------------------------------|------------------------------------------------|
| 200    | Login exitoso                 | `{ "token": "eyJ...", "username": "alice" }`  |
| 400    | Body inválido                 | `{ "error": "..." }`                           |
| 401    | Credenciales incorrectas      | `{ "error": "Credenciales inválidas" }`        |
| 500    | Error interno                 | `{ "error": "Error interno del servidor" }`    |

```bash
curl -X POST http://localhost:4000/login \
  -H "Content-Type: application/json" \
  -d '{"username":"alice","password":"secret123"}'
# Respuesta: { "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...", "username": "alice" }
```

**Estructura del JWT emitido:**
```json
{
  "userId": 1,
  "username": "alice",
  "iat": 1716000000,
  "exp": 1716003600
}
```
- Expiración: **1 hora** desde el login.
- Algoritmo: HS256 (default de jsonwebtoken).

---

## Decisiones de diseño

**bcrypt con 10 rounds** — mínimo exigido por el taller. En producción se subiría a 12.

**Timing-safe login** — si el usuario no existe, se compara igualmente contra un hash dummy, evitando que un atacante descubra usernames válidos midiendo el tiempo de respuesta.

**Mensaje genérico en 401** — tanto "usuario no existe" como "contraseña incorrecta" devuelven el mismo mensaje `"Credenciales inválidas"`. No se filtra cuál falló.

**La contraseña nunca aparece en logs ni en respuestas** — solo el hash queda en SQLite.

**CORS habilitado** — necesario porque el cliente web corre en un origen distinto (puerto 3000 / túnel ngrok diferente).

**Validación en el upgrade del coordinador** — el coordinador verifica el JWT antes de aceptar el WebSocket, no dentro del evento `connection`. Esto evita que el socket quede abierto antes de ser rechazado.

---

## Ngrok

```bash
ngrok http 4000
# Da una URL tipo: https://abc123.ngrok-free.app
# El cliente debe apuntar a esa URL para /register y /login
```

---

## Estructura del repo

```
auth-service/
├── index.js         # Servidor principal
├── package.json
├── .env.example     # Variables de entorno de ejemplo (versionado)
├── .env             # Variables reales (NO versionado, en .gitignore)
├── .gitignore
├── users.db         # Base SQLite (generada al arrancar, en .gitignore)
└── README.md
```