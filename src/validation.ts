/**
 * Reglas de negocio y validación de usuarios.
 *
 * Este módulo es lógica pura: no importa APIs de Cloudflare Workers, no accede
 * a `env`, a la base de datos ni a la red. Por eso puede probarse de forma
 * aislada en CI sin bindings.
 */

export const NAME_MIN_LENGTH = 2;
export const NAME_MAX_LENGTH = 50;
export const EMAIL_MAX_LENGTH = 254;

const NAME_PATTERN = /^[\p{L}][\p{L} '.-]*$/u;
const EMAIL_PATTERN = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;

export interface NewUser {
	name: string;
	email: string;
}

export type ValidationResult =
	| { valid: true; data: NewUser }
	| { valid: false; errors: string[] };

export function validateName(value: unknown): string[] {
	if (value === undefined || value === null) {
		return ["name es requerido"];
	}
	if (typeof value !== "string") {
		return ["name debe ser texto"];
	}

	const name = value.trim();
	if (name.length < NAME_MIN_LENGTH) {
		return [`name debe tener al menos ${NAME_MIN_LENGTH} caracteres`];
	}
	if (name.length > NAME_MAX_LENGTH) {
		return [`name debe tener como máximo ${NAME_MAX_LENGTH} caracteres`];
	}
	if (!NAME_PATTERN.test(name)) {
		return ["name contiene caracteres inválidos"];
	}
	return [];
}

export function validateEmail(value: unknown): string[] {
	if (value === undefined || value === null) {
		return ["email es requerido"];
	}
	if (typeof value !== "string") {
		return ["email debe ser texto"];
	}

	const email = value.trim();
	if (email.length === 0) {
		return ["email es requerido"];
	}
	if (email.length > EMAIL_MAX_LENGTH) {
		return [`email debe tener como máximo ${EMAIL_MAX_LENGTH} caracteres`];
	}
	if (!EMAIL_PATTERN.test(email) || email.includes("..")) {
		return ["email no tiene un formato válido"];
	}
	return [];
}

/**
 * Valida el cuerpo de una petición para crear un usuario y, si es válido,
 * devuelve los datos normalizados (sin espacios extra y email en minúsculas).
 */
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
