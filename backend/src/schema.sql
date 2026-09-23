CREATE TABLE IF NOT EXISTS pool_tables (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'available'
    CHECK (status IN ('available', 'in_game', 'maintenance')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pockets (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  table_id INTEGER NOT NULL REFERENCES pool_tables (id) ON DELETE CASCADE,
  pocket_number SMALLINT NOT NULL CHECK (pocket_number BETWEEN 1 AND 6),
  UNIQUE (table_id, pocket_number)
);

CREATE TABLE IF NOT EXISTS games (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  table_id INTEGER NOT NULL REFERENCES pool_tables (id),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'completed', 'cancelled')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  table_id INTEGER NOT NULL REFERENCES pool_tables (id),
  game_id INTEGER REFERENCES games (id),
  provider TEXT NOT NULL CHECK (provider IN ('mtn', 'airtel')),
  phone TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount > 0),
  currency TEXT NOT NULL DEFAULT 'UGX',
  status TEXT NOT NULL CHECK (status IN ('pending', 'successful', 'failed')),
  mode TEXT NOT NULL DEFAULT 'simulated' CHECK (mode IN ('simulated', 'live')),
  reason TEXT,
  reference TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pocket_events (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  game_id INTEGER REFERENCES games (id) ON DELETE SET NULL,
  pocket_id INTEGER NOT NULL REFERENCES pockets (id),
  ball_label TEXT,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO pool_tables (name)
VALUES ('Table 1'), ('Table 2'), ('Table 3'), ('Table 4'), ('Table 5'), ('Table 6')
ON CONFLICT (name) DO NOTHING;

INSERT INTO pockets (table_id, pocket_number)
SELECT pool_tables.id, pocket_number
FROM pool_tables
CROSS JOIN generate_series(1, 6) AS pocket_number
ON CONFLICT (table_id, pocket_number) DO NOTHING;

ALTER TABLE payments ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'simulated';
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_status_check;
ALTER TABLE payments ADD CONSTRAINT payments_status_check
  CHECK (status IN ('pending', 'successful', 'failed'));
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_mode_check;
ALTER TABLE payments ADD CONSTRAINT payments_mode_check
  CHECK (mode IN ('simulated', 'live'));

ALTER TABLE pocket_events ADD COLUMN IF NOT EXISTS client_event_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS pocket_events_client_event_id_key
  ON pocket_events (client_event_id)
  WHERE client_event_id IS NOT NULL;

ALTER TABLE pool_tables DROP CONSTRAINT IF EXISTS pool_tables_status_check;
ALTER TABLE pool_tables ADD CONSTRAINT pool_tables_status_check
  CHECK (status IN ('available', 'in_game', 'maintenance', 'installing'));

ALTER TABLE pockets ADD COLUMN IF NOT EXISTS installed_at TIMESTAMPTZ;
