# Reporte de Práctica 7: CI/CD, Quality Gates y Multientorno en Cloudflare

**Repositorio GitHub:** [https://github.com/PapaCerdito1503/p5-cloudflare](https://github.com/PapaCerdito1503/p5-cloudflare)  
**URL Desarrollo:** [https://p7-dev.emifragon13.workers.dev](https://p7-dev.emifragon13.workers.dev)  
**URL Producción:** [https://p7-prod.emifragon13.workers.dev](https://p7-prod.emifragon13.workers.dev)  

---

## Resumen de Calificación y Rúbrica

| Criterio de Rúbrica | Puntos | Estado | Detalle / Enlace |
| :--- | :---: | :---: | :--- |
| **Yaml** | 5 pts | ✅ | `.github/workflows/deploy.yml` con 2 jobs, secretos y dependencia `needs` ([Sección 4](#paso-4-pipeline-de-cicd-con-dos-jobs)) |
| **GitHub Action** | 5 pts | ✅ | Ejecución: [run 37243896940](https://github.com/PapaCerdito1503/p5-cloudflare/actions/runs/37243896940) ([Evidencia 1](#-evidencia-1-pipeline-en-github-actions)) |
| **UAT / Coverage Report** | 5 pts | ✅ | Tabla de cobertura Istanbul en el *Summary* del workflow ([Evidencia 2](#-evidencia-2-reporte-de-cobertura-en-el-summary)) |
| **Project URL** | 5 pts | ✅ | [p7-dev](https://p7-dev.emifragon13.workers.dev/users) y [p7-prod](https://p7-prod.emifragon13.workers.dev/users) |
| **Total** | **20 pts** | | |

---

## Arquitectura

```text
                         push a main
                              │
                              ▼
┌──────────────────────── Job 1: Test & Deploy Dev ────────────────────────┐
│ checkout → npm ci → tests + cobertura (Quality Gate) → Summary           │
│          → wrangler deploy → d1 migrations apply                         │
└──────────────────────────────────────────────────────────────────────────┘
                              │ needs: solo si el Job 1 fue exitoso
                              ▼
┌──────────────────────── Job 2: Deploy Prod ──────────────────────────────┐
│ checkout → npm ci → wrangler deploy --env production                     │
│          → d1 migrations apply --env production                          │
└──────────────────────────────────────────────────────────────────────────┘

        Desarrollo                                  Producción
┌────────────────────────┐                ┌────────────────────────┐
│ Worker: p7-dev         │                │ Worker: p7-prod        │
│ D1:     p7-db-dev      │                │ D1:     p7-db-prod     │
└────────────────────────┘                └────────────────────────┘
          (recursos físicamente separados: worker y base propios)
```

Dentro del Worker, el código está dividido en dos capas:

```text
src/index.ts       → Capa HTTP + Base de datos (rutas, JSON, consultas a D1)
       │ delega validación
       ▼
src/validation.ts  → Capa de lógica pura (sin Cloudflare, sin env, sin BD)
       ▲
       │ probada de forma aislada
test/validation.spec.ts
```

---

## Desarrollo Paso a Paso

### Paso 1: Capa de lógica pura y validación

**Problema:** en el pipeline de CI los *runners* de GitHub Actions no tienen acceso a la base D1 ni a los *bindings* de Cloudflare. Si las pruebas unitarias llamaran a endpoints que leen o escriben en la base, el pipeline fallaría.

**Solución:** se extrajeron las reglas de negocio a un módulo independiente, `src/validation.ts`, que **no importa APIs de Cloudflare Workers, no usa `env` y no accede a la base ni a la red**.

| Función | Reglas |
| :--- | :--- |
| `validateName(value)` | Requerido; debe ser texto; de 2 a 50 caracteres (sin contar espacios a los extremos); solo letras (incluye acentos), espacios, `'`, `.` y `-`; debe iniciar con letra |
| `validateEmail(value)` | Requerido; debe ser texto; máximo 254 caracteres; formato `usuario@dominio.tld`; sin puntos consecutivos |
| `validateUser(input)` | El cuerpo debe ser un objeto JSON; acumula los errores de ambos campos; si es válido devuelve los datos **normalizados** (espacios colapsados y email en minúsculas) |

```typescript
export type ValidationResult =
	| { valid: true; data: NewUser }
	| { valid: false; errors: string[] };

export function validateUser(input: unknown): ValidationResult {
	if (typeof input !== "object" || input === null || Array.isArray(input)) {
		return { valid: false, errors: ["el cuerpo debe ser un objeto JSON"] };
	}

	const { name, email } = input as Record<string, unknown>;
	const errors = [...validateName(name), ...validateEmail(email)];
	if (errors.length > 0) {
		return { valid: false, errors };
	}

	return {
		valid: true,
		data: {
			name: (name as string).trim().replace(/\s+/g, " "),
			email: (email as string).trim().toLowerCase(),
		},
	};
}
```

**Nuevo endpoint `POST /users`** en `src/index.ts`. El handler solo se encarga de HTTP y de la base; toda la validación la delega al módulo puro:

```typescript
if (url.pathname === "/users" && request.method === "POST") {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return Response.json({ errors: ["el cuerpo debe ser JSON válido"] }, { status: 400 });
	}

	const result = validateUser(body);
	if (!result.valid) {
		return Response.json({ errors: result.errors }, { status: 400 });
	}

	const existing = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(result.data.email).first();
	if (existing) {
		return Response.json({ errors: ["email ya está registrado"] }, { status: 409 });
	}

	const user = await env.DB.prepare("INSERT INTO users (name, email) VALUES (?, ?) RETURNING id, name, email, created_at")
		.bind(result.data.name, result.data.email)
		.first();
	return Response.json(user, { status: 201 });
}
```

| Caso | Respuesta |
| :--- | :--- |
| Usuario válido | `201 Created` con el registro creado |
| Cuerpo que no es JSON / que no es objeto | `400 Bad Request` |
| Campos inválidos | `400 Bad Request` con la lista de errores |
| Email ya registrado | `409 Conflict` |

Las consultas usan *prepared statements* (`prepare().bind()`): los valores nunca se concatenan al SQL, lo que previene inyección SQL.

---

### Paso 2: Suite de pruebas unitarias y motor de cobertura

**Suite de pruebas (`test/validation.spec.ts`):** 59 pruebas sobre el módulo de validación, **sin ninguna llamada a la base de datos ni a servicios externos**.

| Tipo | Ejemplos |
| :--- | :--- |
| **Positivos** | `"José María"`, `"O'Connor"`, `"Jean-Luc"`, `"a+tag@sub.domain.org"`, normalización de `"  Jose.Maria@Example.COM "` |
| **Negativos** | `null`, `undefined`, números, booleanos, objetos y arreglos en lugar de texto; `"<script>"`, `"Ana; DROP TABLE users"`; emails sin `@`, sin dominio, con `@@`, con espacios o con `..` |
| **Borde** | Nombre de exactamente 50 caracteres (válido) y de 51 (inválido); nombre de solo espacios; email de más de 254 caracteres; cuerpo vacío `{}` (reporta ambos errores) |

**Proveedor de cobertura Istanbul** (`vitest.config.mts`):

```typescript
export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.jsonc" },
		}),
	],
	test: {
		coverage: {
			provider: "istanbul",
			include: ["src/**/*.ts"],
			reporter: [["text", { skipFull: false }], "json-summary", "html"],
			reportsDirectory: "./coverage",
			// Quality Gate: la capa de lógica pura debe estar cubierta al 100%.
			thresholds: {
				"src/validation.ts": {
					statements: 100,
					branches: 100,
					functions: 100,
					lines: 100,
				},
			},
		},
	},
});
```

* Se eligió **Istanbul** porque es el proveedor que pide la práctica y además es el que funciona dentro del runtime de Cloudflare (`workerd`), donde el proveedor V8 no está disponible.
* El **umbral del 100%** sobre `src/validation.ts` convierte la cobertura en un **Quality Gate real**: si se agrega lógica sin pruebas o se eliminan pruebas, el comando termina con error y el pipeline **no despliega**.

**Script en `package.json`:**
```json
"test:coverage": "vitest run --coverage"
```

**Ejecución local:**
```text
$ npm run test:coverage

 Test Files  2 passed (2)
      Tests  61 passed (61)

 % Coverage report from istanbul
---------------|---------|----------|---------|---------|-------------------
File           | % Stmts | % Branch | % Funcs | % Lines | Uncovered Line #s
---------------|---------|----------|---------|---------|-------------------
All files      |   75.47 |    82.22 |     100 |   75.47 |
 index.ts      |   23.52 |    33.33 |     100 |   23.52 | 21-22,27-46
 validation.ts |     100 |      100 |     100 |     100 |
---------------|---------|----------|---------|---------|-------------------
```

**Verificación del Quality Gate:** se ejecutaron únicamente las pruebas antiguas (sin las del validador) para comprobar que el umbral bloquea:
```text
$ npx vitest run --coverage test/index.spec.ts
ERROR: Coverage for lines (13.88%) does not meet "src/validation.ts" threshold (100%)
ERROR: Coverage for functions (0%) does not meet "src/validation.ts" threshold (100%)
ERROR: Coverage for statements (13.88%) does not meet "src/validation.ts" threshold (100%)
ERROR: Coverage for branches (0%) does not meet "src/validation.ts" threshold (100%)
exit code: 1
```

> **Sobre la cobertura de `index.ts` (23.52%):** las líneas sin cubrir son exactamente las que consultan D1 (`GET /users` y `POST /users`). Por diseño, y siguiendo el requisito de no tener llamadas a la base dentro de las pruebas unitarias, esas rutas no se prueban de forma unitaria. Se decidió **no excluir** el archivo del reporte para que la cobertura reportada sea honesta y la deuda técnica quede visible. Probar esas rutas corresponde a pruebas de integración.

---

### Paso 3: Configuración de ambientes en Wrangler

Archivo `wrangler.jsonc`:

```jsonc
{
	// Ambiente por defecto: Desarrollo (`wrangler deploy`)
	"name": "p7-dev",
	"main": "src/index.ts",
	"compatibility_date": "2026-09-17",
	"observability": {
		"enabled": true,
	},
	"d1_databases": [
		{
			"binding": "DB",
			"database_name": "p7-db-dev",
			"migrations_dir": "migrations",
		},
	],
	"env": {
		// Ambiente de Producción (`wrangler deploy --env production`)
		// Los bindings no se heredan entre ambientes: cada uno declara su propia BD.
		"production": {
			"name": "p7-prod",
			"d1_databases": [
				{
					"binding": "DB",
					"database_name": "p7-db-prod",
					"migrations_dir": "migrations",
				},
			],
		},
	},
}
```

| Ambiente | Comando | Worker | Base D1 |
| :--- | :--- | :--- | :--- |
| **Desarrollo** (por defecto) | `wrangler deploy` | `p7-dev` | `p7-db-dev` |
| **Producción** | `wrangler deploy --env production` | `p7-prod` | `p7-db-prod` |

* **Separación física de recursos:** cada ambiente tiene su propio Worker y su propia base de datos. Un error o dato de prueba en desarrollo no puede afectar producción.
* **Sin IDs fijos:** Wrangler 4 resuelve las bases **por nombre** y las crea automáticamente en el primer despliegue (*auto-provisioning*), así que no es necesario guardar `database_id` en el repositorio.

Verificación con *dry-run*:
```text
$ npx wrangler deploy --dry-run
env.DB (p7-db-dev)      D1 Database

$ npx wrangler deploy --dry-run --env production
env.DB (p7-db-prod)     D1 Database
```

---

### Paso 4: Pipeline de CI/CD con dos jobs

Archivo `.github/workflows/deploy.yml`:

```yaml
name: Project p7 - CI/CD

on:
  push:
    branches:
      - main

permissions:
  contents: read

jobs:
  test-and-deploy-dev:
    name: Test & Deploy Dev
    runs-on: ubuntu-latest
    environment:
      name: dev
      url: ${{ steps.deploy.outputs.deployment-url }}
    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Unit tests with coverage (Quality Gate)
        run: npm run test:coverage | tee test-output.txt

      - name: Publish coverage report to summary
        if: always() && hashFiles('coverage/coverage-summary.json') != ''
        run: |
          node scripts/coverage-summary.mjs >> "$GITHUB_STEP_SUMMARY"
          {
            echo ""
            echo "<details><summary>Istanbul text report</summary>"
            echo ""
            echo '```text'
            sed -n '/Coverage report from istanbul/,$p' test-output.txt
            echo '```'
            echo "</details>"
          } >> "$GITHUB_STEP_SUMMARY"

      - name: Deploy to dev
        id: deploy
        uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_KEY }}
          accountId: ${{ secrets.ACCOUNT_ID }}
          command: deploy

      - name: Apply D1 migrations (dev)
        uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_KEY }}
          accountId: ${{ secrets.ACCOUNT_ID }}
          command: d1 migrations apply DB --remote

  deploy-prod:
    name: Deploy Prod
    needs: test-and-deploy-dev
    runs-on: ubuntu-latest
    environment:
      name: production
      url: ${{ steps.deploy.outputs.deployment-url }}
    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Deploy to production
        id: deploy
        uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_KEY }}
          accountId: ${{ secrets.ACCOUNT_ID }}
          command: deploy --env production

      - name: Apply D1 migrations (production)
        uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_KEY }}
          accountId: ${{ secrets.ACCOUNT_ID }}
          command: d1 migrations apply DB --remote --env production
```

**Job 1: Test & Deploy Dev**
1. Descarga el código e instala dependencias con `npm ci`, que respeta exactamente el `package-lock.json` y hace las instalaciones reproducibles.
2. Ejecuta las pruebas con cobertura. Si alguna prueba falla o no se alcanza el umbral, el job falla y no se despliega nada.
3. Publica la tabla de cobertura en `$GITHUB_STEP_SUMMARY`. El paso usa `if: always()`, así que el reporte también se publica cuando las pruebas fallan, para diagnosticar.
4. Despliega el Worker de desarrollo y aplica las migraciones a su base.

**Job 2: Deploy Prod**
* Declara `needs: test-and-deploy-dev`, así que **solo se ejecuta si el Job 1 terminó con éxito** (pruebas, Quality Gate y despliegue a desarrollo).
* Despliega con `--env production` y aplica las migraciones a la base de producción.

**Publicación del reporte de cobertura:** el script `scripts/coverage-summary.mjs` convierte el archivo `coverage/coverage-summary.json` (reporter `json-summary` de Istanbul) en una tabla markdown con indicadores de color (🟢 ≥ 80%, 🟡 ≥ 50%, 🔴 < 50%), que GitHub renderiza en el resumen de la ejecución. Debajo se incluye la tabla original de Istanbul en una sección desplegable.

**Seguridad (DevSecOps):**
* **Secretos:** el API Token y el Account ID de Cloudflare se leen de **GitHub Secrets** y nunca aparecen en el código ni en los logs (GitHub los enmascara como `***`).
* **Mínimo privilegio:** `permissions: contents: read`. El workflow solo puede leer el repositorio; se eliminó el permiso `packages: write` de la práctica anterior porque no se usaba.
* **Environments de GitHub:** cada job declara su ambiente (`dev` / `production`), lo que deja un historial de despliegues por ambiente y permite agregar en el futuro reglas de protección, como aprobación manual antes de producción.

---

### Paso 5: Ejecución del pipeline y verificación de las URLs

Se hizo `push` a la rama `main` (commit `95da3b1`), lo que detonó el workflow **"Project p7 - CI/CD"**:
* **Ejecución:** [https://github.com/PapaCerdito1503/p5-cloudflare/actions/runs/37243896940](https://github.com/PapaCerdito1503/p5-cloudflare/actions/runs/37243896940)

En el primer despliegue, Wrangler creó automáticamente las bases `p7-db-dev` y `p7-db-prod`, y el paso de migraciones creó la tabla `users` con su registro inicial en cada una.

**Desarrollo:**
```text
$ curl -i https://p7-dev.emifragon13.workers.dev/users
HTTP/2 200
content-type: application/json

[{"id":1,"name":"Emiliano Franco","email":"emiliano@example.com","created_at":"2026-10-04 23:29:13"}]
```

**Producción:**
```text
$ curl -i https://p7-prod.emifragon13.workers.dev/users
HTTP/2 200
content-type: application/json

[{"id":1,"name":"Emiliano Franco","email":"emiliano@example.com","created_at":"2026-10-04 23:29:38"}]
```

Las marcas de tiempo distintas (`23:29:13` en desarrollo y `23:29:38` en producción) confirman que son **dos bases de datos independientes** y que producción se migró después de desarrollo, como define la dependencia entre jobs.

**Validación en ambos ambientes:**
```text
$ curl -X POST https://p7-prod.emifragon13.workers.dev/users \
    -H 'content-type: application/json' -d '{"name":"A","email":"nope"}'
{"errors":["name debe tener al menos 2 caracteres","email no tiene un formato válido"]}   [400]
```

---

## Evidencias (Capturas de Pantalla)

---

### 📸 Evidencia 1: Pipeline en GitHub Actions

> **Instrucción para entrega:** Pega aquí la captura de la ejecución en **GitHub Actions** mostrando los dos jobs en verde y su dependencia (**Test & Deploy Dev → Deploy Prod**).

```text
+---------------------------------------------------------------------------------------+
|                                                                                       |
|                  [ PEGAR AQUÍ LA CAPTURA DEL PIPELINE CON 2 JOBS ]                    |
|                                                                                       |
|   ✓ Test & Deploy Dev  ──────▶  ✓ Deploy Prod                                         |
|                                                                                       |
+---------------------------------------------------------------------------------------+
```

---

### 📸 Evidencia 2: Reporte de cobertura en el Summary

> **Instrucción para entrega:** Pega aquí la captura del **Summary** de la ejecución, donde se ve renderizada la tabla **"🧪 Coverage Report (Istanbul)"** con Statements, Branches, Functions y Lines.

```text
+---------------------------------------------------------------------------------------+
|                                                                                       |
|                [ PEGAR AQUÍ LA CAPTURA DEL COVERAGE REPORT EN EL SUMMARY ]            |
|                                                                                       |
+---------------------------------------------------------------------------------------+
```

---

### 📸 Evidencia 3: Aplicación en Desarrollo

> **Instrucción para entrega:** Pega aquí la captura del navegador en `https://p7-dev.emifragon13.workers.dev/users`.

```text
+---------------------------------------------------------------------------------------+
|                                                                                       |
|           [ PEGAR AQUÍ LA CAPTURA DE https://p7-dev.emifragon13.workers.dev/users ]   |
|                                                                                       |
+---------------------------------------------------------------------------------------+
```

---

### 📸 Evidencia 4: Aplicación en Producción

> **Instrucción para entrega:** Pega aquí la captura del navegador en `https://p7-prod.emifragon13.workers.dev/users`.

```text
+---------------------------------------------------------------------------------------+
|                                                                                       |
|          [ PEGAR AQUÍ LA CAPTURA DE https://p7-prod.emifragon13.workers.dev/users ]   |
|                                                                                       |
+---------------------------------------------------------------------------------------+
```

---

## Criterios de Aceptación

| Criterio | Cumplimiento |
| :--- | :--- |
| No hay llamadas a bases de datos ni servicios externos en las pruebas unitarias | ✅ Las pruebas solo importan `src/validation.ts`, que no depende de Cloudflare ni de la base |
| Las pruebas corren en local y reportan Statements, Branches, Functions y Lines | ✅ `npm run test:coverage` (61 pruebas, tabla Istanbul) |
| Wrangler contempla los ambientes `dev` y `production` | ✅ Worker y base D1 propios por ambiente |
| El YAML detona el workflow con `push` a la rama principal | ✅ Ejecutado con el commit `95da3b1` |

---

## Conclusiones Técnicas

1. **Desacoplamiento y testabilidad:**  
   Separar la lógica de negocio de la capa HTTP/BD permite probarla en cualquier entorno, incluido un *runner* de CI sin acceso a Cloudflare. Los handlers quedan delgados y las reglas viven en un solo lugar.
2. **Quality Gate efectivo:**  
   La cobertura no solo se mide, también **bloquea**: el umbral del 100% sobre la capa de lógica impide desplegar código sin pruebas. Publicar el reporte en el *Summary* lo hace visible para el equipo sin tener que revisar logs.
3. **Promoción controlada entre ambientes:**  
   Producción solo recibe una versión que ya pasó las pruebas y se desplegó con éxito en desarrollo. Cada ambiente tiene recursos físicamente separados (Worker y base de datos), así que los errores de desarrollo no alcanzan a producción.
4. **Seguridad en el pipeline:**  
   Las credenciales viven únicamente en GitHub Secrets, el workflow opera con permisos mínimos y las consultas a la base usan *prepared statements*, en línea con las prácticas de DevSecOps.
