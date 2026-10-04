import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

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
