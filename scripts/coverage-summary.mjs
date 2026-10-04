// Convierte coverage/coverage-summary.json (reporter json-summary de Istanbul)
// en una tabla markdown para $GITHUB_STEP_SUMMARY.
import { readFileSync } from "node:fs";
import { relative } from "node:path";

const summary = JSON.parse(readFileSync("coverage/coverage-summary.json", "utf8"));
const metrics = ["statements", "branches", "functions", "lines"];

const icon = (pct) => (pct >= 80 ? "🟢" : pct >= 50 ? "🟡" : "🔴");
const cell = ({ pct, covered, total }) => `${icon(pct)} ${pct}% (${covered}/${total})`;
const row = (name, data) => `| ${name} | ${metrics.map((m) => cell(data[m])).join(" | ")} |`;

const lines = [
	"## 🧪 Coverage Report (Istanbul)",
	"",
	"| File | Statements | Branches | Functions | Lines |",
	"| :--- | :---: | :---: | :---: | :---: |",
	row("**All files**", summary.total),
];

for (const [file, data] of Object.entries(summary)) {
	if (file !== "total") {
		lines.push(row(`\`${relative(process.cwd(), file)}\``, data));
	}
}

console.log(lines.join("\n"));
