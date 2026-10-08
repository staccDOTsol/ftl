import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import { config } from './config.ts'

fs.mkdirSync(config.dataDir, { recursive: true })
export const db = new DatabaseSync(path.join(config.dataDir, 'ftl.db'))

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  chain TEXT NOT NULL, kind TEXT NOT NULL, stage TEXT NOT NULL, lane TEXT NOT NULL,
  venue TEXT NOT NULL, ix TEXT NOT NULL,
  pool TEXT, token TEXT, quote TEXT, wallet TEXT NOT NULL,
  amounts TEXT NOT NULL, quote_ui REAL, fee_bps INTEGER,
  tx TEXT NOT NULL, slot INTEGER NOT NULL, ts INTEGER NOT NULL, confirmed_ts INTEGER,
  flags TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_ts ON events(ts DESC);
CREATE INDEX IF NOT EXISTS events_token ON events(chain, token, ts DESC);
CREATE INDEX IF NOT EXISTS events_wallet ON events(chain, wallet, ts DESC);
CREATE INDEX IF NOT EXISTS events_pool ON events(chain, pool, ts DESC);
CREATE INDEX IF NOT EXISTS events_tx ON events(tx);

CREATE TABLE IF NOT EXISTS pools (
  chain TEXT NOT NULL, address TEXT NOT NULL, venue TEXT NOT NULL,
  token TEXT, quote TEXT, mint_a TEXT, mint_b TEXT, fee_bps INTEGER,
  created_ts INTEGER, creator TEXT, init_tx TEXT,
  liq_events INTEGER NOT NULL DEFAULT 0, funded INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (chain, address)
);
CREATE INDEX IF NOT EXISTS pools_token ON pools(chain, token);

CREATE TABLE IF NOT EXISTS tokens (
  chain TEXT NOT NULL, address TEXT NOT NULL,
  symbol TEXT, name TEXT, image TEXT, decimals INTEGER, meta_ts INTEGER,
  launched_ts INTEGER, launch_venue TEXT, launch_tx TEXT, creator TEXT,
  graduated_ts INTEGER, first_pool_ts INTEGER,
  pools INTEGER NOT NULL DEFAULT 0, funded_pools INTEGER NOT NULL DEFAULT 0,
  lp_wallets INTEGER NOT NULL DEFAULT 0, events INTEGER NOT NULL DEFAULT 0,
  last_ts INTEGER NOT NULL DEFAULT 0, score REAL NOT NULL DEFAULT 0, flags TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (chain, address)
);
CREATE INDEX IF NOT EXISTS tokens_score ON tokens(chain, score DESC, last_ts DESC);
CREATE INDEX IF NOT EXISTS tokens_last ON tokens(last_ts DESC);

CREATE TABLE IF NOT EXISTS wallets (
  chain TEXT NOT NULL, address TEXT NOT NULL, label TEXT,
  inits INTEGER NOT NULL DEFAULT 0, adds INTEGER NOT NULL DEFAULT 0, removes INTEGER NOT NULL DEFAULT 0,
  tokens INTEGER NOT NULL DEFAULT 0, hits INTEGER NOT NULL DEFAULT 0,
  first_ts INTEGER NOT NULL, last_ts INTEGER NOT NULL,
  PRIMARY KEY (chain, address)
);
CREATE INDEX IF NOT EXISTS wallets_hits ON wallets(chain, hits DESC);

-- a wallet's first touch of a launchpad token while it was still on its curve
CREATE TABLE IF NOT EXISTS wallet_tokens (
  chain TEXT NOT NULL, wallet TEXT NOT NULL, token TEXT NOT NULL, first_ts INTEGER NOT NULL, hit INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (chain, wallet, token)
);
CREATE INDEX IF NOT EXISTS wallet_tokens_token ON wallet_tokens(chain, token);

CREATE TABLE IF NOT EXISTS users (
  pubkey TEXT PRIMARY KEY, handle TEXT UNIQUE COLLATE NOCASE, bio TEXT, created_ts INTEGER NOT NULL
);
-- Brief replay guard after account deletion. Store a digest rather than the
-- deleted profile key; stale signed writes must not recreate the account.
CREATE TABLE IF NOT EXISTS account_deletion_guards (
  key_hash TEXT PRIMARY KEY, deleted_ts INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS follows (
  user TEXT NOT NULL, kind TEXT NOT NULL, chain TEXT NOT NULL, address TEXT NOT NULL, ts INTEGER NOT NULL,
  PRIMARY KEY (user, kind, chain, address)
);
CREATE INDEX IF NOT EXISTS follows_target ON follows(kind, chain, address);
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user TEXT NOT NULL, chain TEXT NOT NULL, token TEXT NOT NULL, kind TEXT NOT NULL,
  body TEXT NOT NULL, ts INTEGER NOT NULL, likes INTEGER NOT NULL DEFAULT 0,
  pre_grad INTEGER NOT NULL DEFAULT 0, hit INTEGER
);
CREATE INDEX IF NOT EXISTS posts_token ON posts(chain, token, ts DESC);
CREATE INDEX IF NOT EXISTS posts_ts ON posts(ts DESC);
CREATE INDEX IF NOT EXISTS posts_user ON posts(user, ts DESC);
CREATE TABLE IF NOT EXISTS likes (user TEXT NOT NULL, post INTEGER NOT NULL, PRIMARY KEY (user, post));
CREATE TABLE IF NOT EXISTS push_tokens (token TEXT PRIMARY KEY, user TEXT NOT NULL, platform TEXT, ts INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS push_user ON push_tokens(user);
CREATE TABLE IF NOT EXISTS cursors (name TEXT PRIMARY KEY, value TEXT NOT NULL);

-- Every token with an FTL event is enrolled. The table tracks identity
-- and first-seen time only; research never polls or stores holder snapshots.
CREATE TABLE IF NOT EXISTS research_tokens (
  chain TEXT NOT NULL,
  address TEXT NOT NULL,
  first_seen_ts INTEGER NOT NULL,
  PRIMARY KEY (chain, address)
);
CREATE INDEX IF NOT EXISTS research_tokens_newest ON research_tokens(first_seen_ts DESC, chain DESC, address DESC);
CREATE TABLE IF NOT EXISTS research_lp_events (
  id TEXT PRIMARY KEY,
  chain TEXT NOT NULL,
  address TEXT NOT NULL,
  kind TEXT NOT NULL,
  first_seen_ts INTEGER NOT NULL,
  confirmed_ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS research_lp_events_address ON research_lp_events(chain, address, first_seen_ts);
-- Actual executed swaps from the existing Yellowstone stream, plus event-
-- driven OHLCV aggregates. These are trades, not periodic price snapshots.
CREATE TABLE IF NOT EXISTS research_swaps (
  id TEXT PRIMARY KEY,
  chain TEXT NOT NULL,
  token TEXT NOT NULL,
  quote TEXT NOT NULL,
  quote_symbol TEXT NOT NULL,
  venue TEXT NOT NULL,
  instruction TEXT NOT NULL,
  slot INTEGER NOT NULL,
  bank_id TEXT,
  finalized INTEGER NOT NULL DEFAULT 0,
  ts INTEGER NOT NULL,
  token_ui REAL NOT NULL,
  quote_ui REAL NOT NULL,
  price_quote REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS research_swaps_token_ts ON research_swaps(chain, token, quote, ts DESC);
-- Connectivity intervals are stream events, not periodic data snapshots.
-- A crash leaves the previous interval ending at its last received pulse.
CREATE TABLE IF NOT EXISTS research_stream_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lane TEXT NOT NULL,
  token TEXT,
  started_ts INTEGER NOT NULL,
  last_pulse_ts INTEGER NOT NULL,
  ended_ts INTEGER,
  gap_reason TEXT
);
CREATE TABLE IF NOT EXISTS research_stream_health (
  lane TEXT PRIMARY KEY,
  last_pulse_ts INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS research_trade_candles (
  chain TEXT NOT NULL,
  token TEXT NOT NULL,
  quote TEXT NOT NULL,
  quote_symbol TEXT NOT NULL,
  day_ts INTEGER NOT NULL,
  open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL, close REAL NOT NULL,
  volume_quote REAL NOT NULL, trades INTEGER NOT NULL,
  first_trade_ts INTEGER NOT NULL, last_trade_ts INTEGER NOT NULL,
  PRIMARY KEY (chain, token, quote, day_ts)
);
CREATE INDEX IF NOT EXISTS research_trade_candles_token_day ON research_trade_candles(chain, token, day_ts DESC);
-- Slot metadata is a bounded event log from a finalized stream. It supplies
-- canonical timestamps for streamed trades without per-transaction RPC reads.
CREATE TABLE IF NOT EXISTS research_solana_blocktime (
  slot INTEGER PRIMARY KEY,
  blockhash TEXT,
  block_ts INTEGER,
  finalized INTEGER NOT NULL DEFAULT 0,
  seen_ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS research_solana_blocktime_seen ON research_solana_blocktime(seen_ts);
`)

for (const col of ['description TEXT', 'twitter TEXT', 'website TEXT']) {
  try { db.exec(`ALTER TABLE tokens ADD COLUMN ${col}`) } catch {}
}

for (const col of ['bank_id TEXT', 'finalized INTEGER NOT NULL DEFAULT 0']) {
  try { db.exec(`ALTER TABLE research_swaps ADD COLUMN ${col}`) } catch {}
}
db.exec('CREATE INDEX IF NOT EXISTS research_swaps_slot_finality ON research_swaps(slot, finalized)')
for (const col of ['token TEXT', 'gap_reason TEXT']) {
  try { db.exec(`ALTER TABLE research_stream_sessions ADD COLUMN ${col}`) } catch {}
}
db.exec('CREATE INDEX IF NOT EXISTS research_stream_sessions_window ON research_stream_sessions(token, started_ts, ended_ts)')
// A post can carry the move that prompted it: the Solana signature and a JSON
// summary of the swap or liquidity operation (see Move in shared/types.ts).
for (const col of ['tx TEXT', 'move TEXT']) {
  try { db.exec(`ALTER TABLE posts ADD COLUMN ${col}`) } catch {}
}

export function tx<T>(fn: () => T): T {
  db.exec('BEGIN')
  try { const r = fn(); db.exec('COMMIT'); return r } catch (e) { db.exec('ROLLBACK'); throw e }
}

export function getCursor(name: string): string | null {
  const r = db.prepare('SELECT value FROM cursors WHERE name = ?').get(name) as { value: string } | undefined
  return r?.value ?? null
}
export function setCursor(name: string, value: string): void {
  db.prepare('INSERT INTO cursors(name, value) VALUES(?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value').run(name, value)
}
