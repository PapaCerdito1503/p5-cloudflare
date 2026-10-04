# Reporte de Práctica 6: Base de Datos D1 en Cloudflare Workers

**Repositorio GitHub:** [https://github.com/PapaCerdito1503/p5-cloudflare](https://github.com/PapaCerdito1503/p5-cloudflare)  
**URL de la Aplicación (Producción):** [https://p5.emifragon13.workers.dev/users](https://p5.emifragon13.workers.dev/users)  

---

## Objetivo

Extender el Worker de la práctica anterior para conectarlo a una base de datos **SQLite serverless (Cloudflare D1)**:

1. Crear una BD SQLite D1 en Cloudflare.
2. Crear una tabla de ejemplo y agregar un registro.
3. Agregar la referencia de la base de datos a la configuración del worker (`wrangler.jsonc`).
4. Agregar un método que lea la BD.

**Evidencia requerida:** Captura de la respuesta en la URL de la página publicada.

---

## Arquitectura

```text
 Navegador / curl
       │  GET /users
       ▼
┌───────────────────────────┐        binding "DB"        ┌──────────────────────┐
│  Cloudflare Worker (p5)   │ ─────────────────────────▶ │  D1 (SQLite): p6-db  │
│  src/index.ts             │ ◀───────────────────────── │  tabla: users        │
└───────────────────────────┘      resultados (JSON)     └──────────────────────┘
       ▲
       │  push a main / workflow_dispatch
┌───────────────────────────┐
│      GitHub Actions       │  deploy.yml   → pruebas + despliegue del Worker
│                           │  db-setup.yml → crea la BD y aplica migraciones
└───────────────────────────┘
```

---

## Desarrollo Paso a Paso según Requisitos

### Paso 1: Creación de la base de datos D1 en Cloudflare

En lugar de crear la base manualmente desde el dashboard o desde la terminal local, la creación se automatizó con un workflow de GitHub Actions de ejecución manual (`workflow_dispatch`). Así la infraestructura se aprovisiona desde el pipeline, usando las credenciales guardadas en **GitHub Secrets**, sin exponer el token de Cloudflare en ninguna máquina local.

Archivo `.github/workflows/db-setup.yml`:
```yaml
name: D1 Setup

on:
  workflow_dispatch:

jobs:
  db-setup:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    env:
      CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_KEY }}
      CLOUDFLARE_ACCOUNT_ID: ${{ secrets.ACCOUNT_ID }}
      DB_NAME: p6-db
    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 22

      - name: Install dependencies
        run: npm ci

      - name: Create D1 database (if missing)
        run: |
          if npx wrangler d1 info "$DB_NAME" > /dev/null 2>&1; then
            echo "La base $DB_NAME ya existe, se omite la creación."
          else
            npx wrangler d1 create "$DB_NAME"
          fi

      - name: Apply migrations
        run: npx wrangler d1 migrations apply "$DB_NAME" --remote

      - name: Verify data
        run: |
          {
            echo "## D1: $DB_NAME"
            echo '```'
            npx wrangler d1 info "$DB_NAME"
            echo '```'
            echo "### SELECT * FROM users"
            echo '```json'
            npx wrangler d1 execute "$DB_NAME" --remote --json --command "SELECT * FROM users"
            echo '```'
          } >> "$GITHUB_STEP_SUMMARY"
```

Características del workflow:
* **Idempotente:** si la base `p6-db` ya existe, no intenta crearla de nuevo.
* **Mínimo privilegio:** el job solo tiene permiso de lectura sobre el repositorio (`contents: read`).
* **Auditable:** el resultado (información de la BD y contenido de la tabla) se publica en el *Summary* de la ejecución.

> **Nota de permisos:** el API Token de Cloudflare debe incluir el permiso **Account → D1 → Edit** además de los permisos de edición de Workers.

---

### Paso 2: Creación de la tabla de ejemplo y registro inicial

El esquema se definió como una **migración versionada** de D1 (`migrations/0001_init.sql`). Esto permite que los cambios de la base vivan en el repositorio junto con el código y que D1 lleve el control de qué migraciones ya se aplicaron (tabla interna `d1_migrations`):

```sql
-- Migration number: 0001 	 Tabla de ejemplo con un registro inicial

CREATE TABLE IF NOT EXISTS users (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	name TEXT NOT NULL,
	email TEXT NOT NULL UNIQUE,
	created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO users (name, email) VALUES ('Emiliano Franco', 'emiliano@example.com');
```

* `CREATE TABLE IF NOT EXISTS` e `INSERT OR IGNORE` hacen que el script pueda ejecutarse más de una vez sin errores ni registros duplicados.
* La restricción `UNIQUE` sobre `email` evita duplicados a nivel de base de datos.

La migración se aplica en el paso **"Apply migrations"** del workflow:
```bash
npx wrangler d1 migrations apply p6-db --remote
```

---

### Paso 3: Referencia de la base de datos en `wrangler.jsonc`

Se agregó el *binding* `DB` en la configuración del Worker:

```jsonc
{
	"name": "p5",
	"main": "src/index.ts",
	"compatibility_date": "2026-09-17",
	"observability": {
		"enabled": true,
	},
	"d1_databases": [
		{
			"binding": "DB",
			"database_name": "p6-db",
			"migrations_dir": "migrations",
		},
	],
}
```

* **`binding`:** nombre con el que el código accede a la base (`env.DB`).
* **`database_name`:** Wrangler 4 resuelve la base **por nombre** contra la API de Cloudflare, así que no es necesario fijar el `database_id` en el repositorio. Además, al desplegar, Wrangler enlaza la base automáticamente (*auto-provisioning*).
* **`migrations_dir`:** carpeta donde viven las migraciones SQL.

Después se regeneraron los tipos de TypeScript para que el objeto `Env` incluya la base:
```bash
npm run cf-typegen
```
```typescript
// worker-configuration.d.ts (extracto)
interface Env {
	DB: D1Database;
}
```

---

### Paso 4: Método para leer la base de datos

Se agregó la ruta `GET /users` en `src/index.ts`. Consulta la tabla mediante el binding `env.DB` y devuelve los registros en formato JSON:

```typescript
export default {
	async fetch(request, env, ctx): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === "/users" && request.method === "GET") {
			const { results } = await env.DB.prepare("SELECT id, name, email, created_at FROM users").all();
			return Response.json(results);
		}

		return new Response("Hello World! aaaaaa123123");
	},
} satisfies ExportedHandler<Env>;
```

* Se usa `prepare()` (consultas preparadas) de la API de D1, que es la forma recomendada de evitar inyección SQL cuando la consulta recibe parámetros.
* La ruta raíz `/` conserva la respuesta de la práctica anterior, así que las pruebas existentes siguen pasando.

---

### Paso 5: Verificación local

Antes de publicar, se validó todo en local con una base D1 local (Miniflare):

```text
$ npx wrangler d1 migrations apply p6-db --local
🚣 3 commands executed successfully.
┌───────────────┬────────┐
│ name          │ status │
├───────────────┼────────┤
│ 0001_init.sql │ ✅     │
└───────────────┴────────┘

$ npx wrangler dev
$ curl -i http://localhost:8787/users
HTTP/1.1 200 OK
Content-Type: application/json

[{"id":1,"name":"Emiliano Franco","email":"emiliano@example.com","created_at":"2026-10-04 22:56:04"}]
```

Pruebas automatizadas y verificación de tipos:
```text
$ npx vitest run
 Test Files  1 passed (1)
      Tests  2 passed (2)

$ npx tsc --noEmit
(sin errores)
```

---

### Paso 6: Publicación

1. Se hizo `push` a la rama `main`, lo que detonó el pipeline **"Project p5"** (`deploy.yml`): ejecuta las pruebas y despliega el Worker con el binding de D1.
2. Desde **GitHub → Actions → "D1 Setup" → Run workflow** se ejecutó el workflow manual, que creó la base `p6-db` y aplicó la migración.
3. Se consultó la URL pública del endpoint:
   * **URL:** `https://p5.emifragon13.workers.dev/users`

Verificación de respuesta en producción con cURL:
```text
$ curl -i https://p5.emifragon13.workers.dev/users
HTTP/2 200 
content-type: application/json

[{"id":1,"name":"Emiliano Franco","email":"emiliano@example.com","created_at":"2026-10-04 23:08:04"}]
```

> **Incidencia resuelta:** el primer despliegue falló con `Authentication error [code: 10000]` al consultar `/accounts/.../d1/database/p6-db`, porque el API Token solo tenía permisos de Workers. Se agregó el permiso **Account → D1 → Edit** al token y se re-ejecutó el job, que terminó correctamente.

---

## Evidencias (Capturas de Pantalla)

---

### 📸 Evidencia 1: Respuesta de la URL publicada

> **Instrucción para entrega:** Pega aquí la captura del **navegador** con la URL `https://p5.emifragon13.workers.dev/users` en la barra de direcciones y la respuesta JSON en pantalla.

```text
+---------------------------------------------------------------------------------------+
|                                                                                       |
|               [ PEGAR AQUÍ LA CAPTURA DE https://p5.emifragon13.workers.dev/users ]   |
|                                                                                       |
|   Respuesta esperada:                                                                 |
|   [{"id":1,"name":"Emiliano Franco","email":"emiliano@example.com",...}]              |
|                                                                                       |
+---------------------------------------------------------------------------------------+
```

---

### 📸 Evidencia 2 (complementaria): Workflow "D1 Setup" en GitHub Actions

> **Instrucción para entrega:** Pega aquí la captura del **Summary** del workflow "D1 Setup", donde aparece la información de la base `p6-db` y el resultado del `SELECT * FROM users`.

```text
+---------------------------------------------------------------------------------------+
|                                                                                       |
|                  [ PEGAR AQUÍ LA CAPTURA DEL SUMMARY DE "D1 SETUP" ]                  |
|                                                                                       |
+---------------------------------------------------------------------------------------+
```

---

### 📸 Evidencia 3 (complementaria): Base de datos en el dashboard de Cloudflare

> **Instrucción para entrega:** Pega aquí la captura de **Cloudflare → Storage & Databases → D1 → p6-db**, mostrando la tabla `users` con su registro.

```text
+---------------------------------------------------------------------------------------+
|                                                                                       |
|                 [ PEGAR AQUÍ LA CAPTURA DE LA BD EN EL DASHBOARD ]                    |
|                                                                                       |
+---------------------------------------------------------------------------------------+
```

---

## Conclusiones Técnicas

1. **Persistencia serverless en el edge:**  
   D1 da una base SQL relacional sin administrar servidores. El Worker accede a ella por un *binding* declarado en la configuración, sin cadenas de conexión ni credenciales en el código.
2. **Infraestructura como código:**  
   Tanto el esquema (migraciones versionadas) como la creación de la base (workflow `db-setup.yml`) viven en el repositorio, lo que hace al entorno reproducible y auditable.
3. **Seguridad (DevSecOps):**  
   El token de Cloudflare solo existe en GitHub Secrets. Los workflows usan permisos mínimos y el `database_id` no se fija en el código. Las consultas usan *prepared statements* de D1.
4. **Base para la siguiente práctica:**  
   La estructura queda lista para separar entornos (`dev` / `production`), con una base D1 independiente para cada uno.
