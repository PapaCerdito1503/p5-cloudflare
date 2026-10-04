-- Migration number: 0001 	 Tabla de ejemplo con un registro inicial

CREATE TABLE IF NOT EXISTS users (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	name TEXT NOT NULL,
	email TEXT NOT NULL UNIQUE,
	created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO users (name, email) VALUES ('Emiliano Franco', 'emiliano@example.com');
