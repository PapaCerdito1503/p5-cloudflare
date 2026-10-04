import { describe, it, expect } from "vitest";
import {
	validateName,
	validateEmail,
	validateUser,
	NAME_MAX_LENGTH,
	EMAIL_MAX_LENGTH,
} from "../src/validation";

describe("validateName", () => {
	it.each(["Emiliano", "Ana", "José María", "O'Connor", "Jean-Luc", "Dr. House", "Al"])(
		"acepta el nombre válido %j",
		(name) => {
			expect(validateName(name)).toEqual([]);
		},
	);

	it("acepta exactamente la longitud máxima", () => {
		expect(validateName("a".repeat(NAME_MAX_LENGTH))).toEqual([]);
	});

	it("ignora espacios al inicio y al final al medir la longitud", () => {
		expect(validateName("   Ana   ")).toEqual([]);
	});

	it.each([undefined, null])("rechaza %j como requerido", (name) => {
		expect(validateName(name)).toEqual(["name es requerido"]);
	});

	it.each([123, true, {}, ["Ana"]])("rechaza el tipo no texto %j", (name) => {
		expect(validateName(name)).toEqual(["name debe ser texto"]);
	});

	it.each(["", " ", "A", "  A  "])("rechaza el nombre demasiado corto %j", (name) => {
		expect(validateName(name)).toEqual(["name debe tener al menos 2 caracteres"]);
	});

	it("rechaza un nombre que excede la longitud máxima", () => {
		expect(validateName("a".repeat(NAME_MAX_LENGTH + 1))).toEqual([
			`name debe tener como máximo ${NAME_MAX_LENGTH} caracteres`,
		]);
	});

	it.each(["Ana123", "<script>", "Ana; DROP TABLE users", "-Ana", "@na"])(
		"rechaza caracteres inválidos en %j",
		(name) => {
			expect(validateName(name)).toEqual(["name contiene caracteres inválidos"]);
		},
	);
});

describe("validateEmail", () => {
	it.each(["user@example.com", "first.last@iteso.mx", "a+tag@sub.domain.org", "USER@EXAMPLE.COM", "x_y-z@my-site.io"])(
		"acepta el email válido %j",
		(email) => {
			expect(validateEmail(email)).toEqual([]);
		},
	);

	it.each([undefined, null, "", "   "])("rechaza %j como requerido", (email) => {
		expect(validateEmail(email)).toEqual(["email es requerido"]);
	});

	it.each([42, false, {}, ["a@b.com"]])("rechaza el tipo no texto %j", (email) => {
		expect(validateEmail(email)).toEqual(["email debe ser texto"]);
	});

	it.each([
		"plainaddress",
		"@example.com",
		"user@",
		"user@example",
		"user@@example.com",
		"user@example.c",
		"user name@example.com",
		"user@exa_mple.com",
		"user..dots@example.com",
		"user@example..com",
	])("rechaza el formato inválido %j", (email) => {
		expect(validateEmail(email)).toEqual(["email no tiene un formato válido"]);
	});

	it("rechaza un email que excede la longitud máxima", () => {
		const email = `${"a".repeat(EMAIL_MAX_LENGTH)}@example.com`;
		expect(validateEmail(email)).toEqual([`email debe tener como máximo ${EMAIL_MAX_LENGTH} caracteres`]);
	});
});

describe("validateUser", () => {
	it("acepta un usuario válido y normaliza sus datos", () => {
		expect(validateUser({ name: "  José   María ", email: "  Jose.Maria@Example.COM " })).toEqual({
			valid: true,
			data: { name: "José María", email: "jose.maria@example.com" },
		});
	});

	it("ignora campos adicionales", () => {
		expect(validateUser({ name: "Ana", email: "ana@example.com", role: "admin" })).toEqual({
			valid: true,
			data: { name: "Ana", email: "ana@example.com" },
		});
	});

	it.each([null, undefined, "texto", 42, true, ["Ana", "ana@example.com"]])(
		"rechaza el cuerpo que no es objeto %j",
		(input) => {
			expect(validateUser(input)).toEqual({ valid: false, errors: ["el cuerpo debe ser un objeto JSON"] });
		},
	);

	it("reporta todos los errores a la vez", () => {
		expect(validateUser({})).toEqual({
			valid: false,
			errors: ["name es requerido", "email es requerido"],
		});
	});

	it("reporta solo el campo inválido", () => {
		expect(validateUser({ name: "Ana", email: "no-es-email" })).toEqual({
			valid: false,
			errors: ["email no tiene un formato válido"],
		});
		expect(validateUser({ name: "A", email: "ana@example.com" })).toEqual({
			valid: false,
			errors: ["name debe tener al menos 2 caracteres"],
		});
	});
});
