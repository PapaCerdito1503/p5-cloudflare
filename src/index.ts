/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Bind resources to your worker in `wrangler.jsonc`. After adding bindings, a type definition for the
 * `Env` object can be regenerated with `npm run cf-typegen`.
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

import { validateUser } from "./validation";

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === "/users" && request.method === "GET") {
			const { results } = await env.DB.prepare("SELECT id, name, email, created_at FROM users").all();
			return Response.json(results);
		}

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

		return new Response("Hello World! aaaaaa123123");
	},
} satisfies ExportedHandler<Env>;
