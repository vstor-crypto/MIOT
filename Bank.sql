CREATE TABLE IF NOT EXISTS dispositivos (
  id TEXT PRIMARY KEY,
  nome TEXT NOT NULL,
  simulado INTEGER NOT NULL DEFAULT 0,
  criado_em INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER))
);

CREATE TABLE IF NOT EXISTS leituras (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dispositivo_id TEXT NOT NULL REFERENCES dispositivos (id) ON DELETE CASCADE,
  temperatura REAL NOT NULL,
  umidade REAL NOT NULL,
  criado_em INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER))
);

CREATE INDEX IF NOT EXISTS idx_leituras_dispositivo_tempo
  ON leituras (dispositivo_id, criado_em DESC);

CREATE TABLE IF NOT EXISTS alertas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dispositivo_id TEXT REFERENCES dispositivos (id) ON DELETE SET NULL,
  mensagem TEXT NOT NULL,
  criado_em INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER))
);

CREATE TABLE IF NOT EXISTS configuracoes (
  chave TEXT PRIMARY KEY,
  valor REAL NOT NULL
);

INSERT OR IGNORE INTO configuracoes (chave, valor) VALUES
  ('limite_temp', 30),
  ('limite_umid', 30),
  ('offline_s', 8);