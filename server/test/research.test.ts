import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import bs58 from 'bs58'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ftl-research-test-'))
process.env.DATA_DIR = tmp
const { db } = await import('../src/db.ts')
const { bus } = await import('../src/hub.ts')
const { getResearch, listResearch, startResearch, validSolanaMint, ingestSwap, ingestRobinhoodSwap, onResearchSwapStream, onResearchSwapStreamBatch, computeBottoming } = await import('../src/research.ts')
const { extractSwap, looksLikeSwap, USDC } = await import('../src/solana/swaps.ts')
const { __toNTx } = await import('../src/solana/lanes.ts')
after(() => { db.close(); fs.rmSync(tmp, { recursive: true, force: true }) })

const mint = (n: number) => bs58.encode(Buffer.alloc(32, n))
const rh = `0x${'a'.repeat(40)}`

test('auto-enrolls the entire FTL-seen universe across both chains with cursor pagination and no provider calls', () => {
  let providerCalls = 0
  const oldFetch = globalThis.fetch
  globalThis.fetch = async () => { providerCalls++; throw new Error('unexpected research provider call') }
  try {
    const insert = db.prepare('INSERT INTO tokens(chain, address, last_ts, events) VALUES(?,?,?,?)')
    for (let n = 1; n <= 65; n++) insert.run('solana', mint(n), 1000 + n, 1)
    insert.run('solana', mint(66), 2000, 0) // a metadata-only row is not an FTL event subject
    insert.run('robinhood', rh, 2000, 1)
    db.prepare(`INSERT INTO events
      (id,chain,kind,stage,lane,venue,ix,pool,token,quote,wallet,amounts,quote_ui,fee_bps,tx,slot,ts,confirmed_ts,flags)
      VALUES ('old:pool', 'solana', 'pool_init', 'confirmed', 'geyser', 'test', 'test', 'pool-old', ?, NULL, 'wallet-old', '[]', NULL, NULL, 'tx-old', 1, 500, 550, '[]')`).run(mint(1))
    db.prepare(`INSERT INTO events
      (id,chain,kind,stage,lane,venue,ix,pool,token,quote,wallet,amounts,quote_ui,fee_bps,tx,slot,ts,confirmed_ts,flags)
      VALUES ('rh:pool', 'robinhood', 'pool_init', 'confirmed', 'logs', 'test', 'test', 'pool-rh', ?, NULL, 'wallet-rh', '[]', NULL, NULL, 'tx-rh', 1, 600, 650, '[]')`).run(rh)
    startResearch()
    assert.equal(getResearch('solana', mint(1)).liveLiquidity.poolInits, 1) // retained FTL history is migrated once
    assert.equal(getResearch('robinhood', rh.toUpperCase()).chain, 'robinhood')
    assert.equal(getResearch('robinhood', rh).liveLiquidity.poolInits, 1)

    const seen = new Set<string>()
    let cursor: string | null = null
    do {
      const q = new URLSearchParams({ limit: '17' })
      if (cursor) q.set('cursor', cursor)
      const page = listResearch(q)
      assert.equal(page.total, 66)
      assert.equal(page.backlog, null)
      assert.ok(page.items.length <= 17)
      for (const item of page.items) {
        assert.equal(item.status, item.chain === 'solana' ? 'queued' : 'source_unavailable')
        assert.equal(item.holderStrength.score, null)
        assert.equal(item.bottoming.signs, null)
        assert.equal(item.coverage.holderBootstrapAttempts, 0)
        assert.equal(item.coverage.holderState, item.chain === 'solana' ? 'pending' : 'unconfigured')
        assert.equal(item.coverage.priceCandles, 0)
        seen.add(`${item.chain}:${item.address}`)
      }
      cursor = page.nextCursor
    } while (cursor)
    assert.equal(seen.size, 66)
    assert.ok(seen.has(`robinhood:${rh}`))
    assert.equal(providerCalls, 0)
    assert.match(listResearch().coverageNote, /Solana and Robinhood Chain/)
  } finally { globalThis.fetch = oldFetch }
})

test('research search and chain filters paginate the indexed universe without provider calls', () => {
  for (let n = 1; n <= 9; n++)
    db.prepare('UPDATE tokens SET name=? WHERE chain=? AND address=?').run('Search Pack', 'solana', mint(n))
  db.prepare('UPDATE tokens SET symbol=?,name=? WHERE chain=? AND address=?')
    .run('SOCIAL', 'Social Alpha', 'robinhood', rh)
  let cursor: string | null = null
  const found = new Set<string>()
  do {
    const q = new URLSearchParams({ chain: 'solana', search: 'search pack', limit: '4' })
    if (cursor) q.set('cursor', cursor)
    const page = listResearch(q)
    assert.equal(page.total, 9)
    assert.ok(page.items.length <= 4)
    for (const coin of page.items) {
      assert.equal(coin.chain, 'solana')
      assert.equal(coin.name, 'Search Pack')
      found.add(coin.address)
    }
    cursor = page.nextCursor
  } while (cursor)
  assert.equal(found.size, 9)
  assert.deepEqual(listResearch(new URLSearchParams({ search: 'social' })).items.map(x => x.address), [rh])
  assert.deepEqual(listResearch(new URLSearchParams({ chain: 'robinhood', search: rh.toUpperCase() })).items.map(x => x.address), [rh])
  assert.equal(listResearch(new URLSearchParams({ chain: 'robinhood', search: 'Search Pack' })).total, 0)
  assert.throws(() => listResearch(new URLSearchParams({ chain: 'base' })), /invalid research chain/)
  assert.throws(() => listResearch(new URLSearchParams({ search: 'x'.repeat(81) })), /research search is too long/)
})

test('new FTL events enroll tokens and confirmed LP observations update without polling', () => {
  const address = mint(67)
  const notices: { chain: string; address: string; enrolled: boolean }[] = []
  const onResearch = (chain: string, address: string, enrolled: boolean) => notices.push({ chain, address, enrolled })
  bus.on('research', onResearch)
  db.prepare('INSERT INTO tokens(chain,address,last_ts,events) VALUES(?,?,?,?)').run('solana', address, 5000, 1)
  bus.emit('token', 'solana', address)
  assert.deepEqual(notices, [{ chain: 'solana', address, enrolled: true }])
  assert.equal(getResearch('solana', address).firstSeenTs, 5000)
  assert.equal(getResearch('solana', address).liveLiquidity.adds, 0)

  const insertEvent = db.prepare(`INSERT INTO events
    (id,chain,kind,stage,lane,venue,ix,pool,token,quote,wallet,amounts,quote_ui,fee_bps,tx,slot,ts,confirmed_ts,flags)
    VALUES (?, 'solana', ?, ?, 'geyser', 'test', 'test', ?, ?, NULL, ?, '[]', NULL, NULL, ?, 1, ?, ?, '[]')`)
  insertEvent.run('test:pending', 'liq_add', 'pending', 'pool-1', address, 'wallet-1', 'tx-1', 5100, null)
  assert.equal(getResearch('solana', address).liveLiquidity.adds, 0)
  db.prepare("UPDATE events SET stage = 'confirmed', confirmed_ts = ? WHERE id = ?").run(5200, 'test:pending')
  bus.emit('upgrade', { t: 'upgrade', id: 'test:pending', stage: 'confirmed' })
  assert.deepEqual(notices.at(-1), { chain: 'solana', address, enrolled: false })
  assert.deepEqual(getResearch('solana', address).liveLiquidity, {
    poolInits: 0, adds: 1, removes: 0, observationStartTs: 5100, lastEventTs: 5200,
  })
  insertEvent.run('test:remove', 'liq_remove', 'confirmed', 'pool-1', address, 'wallet-1', 'tx-2', 5300, 5300)
  bus.emit('event', { id: 'test:remove', chain: 'solana', token: address, kind: 'liq_remove', stage: 'confirmed', ts: 5300 })
  assert.equal(getResearch('solana', address).liveLiquidity.removes, 1)
  db.prepare("DELETE FROM events WHERE id IN ('test:pending','test:remove')").run()
  assert.equal(getResearch('solana', address).liveLiquidity.adds, 1) // hub event retention cannot erase research observations
  assert.equal(getResearch('solana', address).liveLiquidity.removes, 1)
  assert.equal(getResearch('solana', address).bottoming.signs, null)
  assert.equal(getResearch('solana', address).holderStrength.score, null)
  bus.off('research', onResearch)
})

test('bulk stream acknowledgement preserves per-token session and replay semantics', () => {
  const a = mint(87), b = mint(88), ts = Date.now()
  for (const token of [a, b]) {
    db.prepare('INSERT INTO tokens(chain,address,last_ts,events) VALUES(?,?,?,1)').run('solana', token, ts)
    bus.emit('token', 'solana', token)
  }
  onResearchSwapStreamBatch([a, b].map(token =>
    ({ t: 'open' as const, lane: 'laserstream' as const, token, ts })))
  const sessions = db.prepare(`SELECT token,ended_ts FROM research_stream_sessions
    WHERE token IN (?,?) ORDER BY token`).all(a, b) as { token: string; ended_ts: number | null }[]
  assert.equal(sessions.length, 2)
  assert.ok(sessions.every(row => row.ended_ts === null))
  onResearchSwapStream({ t: 'close', lane: 'laserstream', token: a, ts: ts + 1 })
  onResearchSwapStreamBatch([{ t: 'resume', lane: 'laserstream', token: a, ts: ts + 2,
    fromSlot: 1 }])
  const aSessions = db.prepare(`SELECT ended_ts,gap_reason FROM research_stream_sessions
    WHERE token=? ORDER BY id`).all(a) as { ended_ts: number | null; gap_reason: string | null }[]
  assert.deepEqual(aSessions.map(row => ({ ...row })), [{ ended_ts: null, gap_reason: null }])
})

test('holder strength uses only a complete live baseline and seven verified days', () => {
  const token = mint(68)
  const now = Date.now()
  db.prepare('INSERT INTO tokens(chain,address,last_ts,events) VALUES(?,?,?,?)').run('solana', token, now, 1)
  bus.emit('token', 'solana', token)
  assert.equal(getResearch('solana', token).holderStrength.score, null)
  const state = db.prepare(`UPDATE research_holder_state SET
    program_id=?,state='live',stream_ok=1,attempted_at=?,baseline_slot=?,baseline_ts=?,
    last_slot=?,covered_through_slot=?,last_ts=?,baseline_top20_share=100 WHERE mint=?`)
  state.run('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    now - 6 * 86_400_000, 100, now - 6 * 86_400_000, 150, 151, now, token)
  const addOwner = db.prepare('INSERT INTO research_holder_owners(mint,owner,amount) VALUES(?,?,?)')
  addOwner.run(token, mint(100), '80')
  for (let n = 101; n <= 120; n++) addOwner.run(token, mint(n), '1')
  db.prepare('INSERT INTO research_holder_baseline_top(mint,owner,amount) VALUES(?,?,?)')
    .run(token, mint(100), '100')
  const early = getResearch('solana', token)
  assert.equal(early.holderStrength.score, null)
  assert.equal(early.holderStrength.retentionPct, 80)
  assert.equal(early.holderStrength.top20SharePct, 99)
  assert.equal(early.holderStrength.top20ShareChangePct, -1)
  assert.equal(early.coverage.holderBootstrapAttempts, 1)
  assert.equal(early.coverage.holderState, 'live')
  db.prepare('UPDATE research_holder_state SET baseline_ts = ? WHERE mint = ?')
    .run(now - 8 * 86_400_000, token)
  const mature = getResearch('solana', token)
  assert.equal(mature.holderStrength.score, 56.3)
  assert.equal(mature.status, 'insufficient_data') // bottoming still needs 30 covered price days
  const today = Math.floor(now / 86_400_000) * 86_400_000
  db.prepare(`INSERT INTO research_stream_sessions(lane,token,started_ts,last_pulse_ts)
    VALUES('laserstream',?,?,?)`).run(token, today - 31 * 86_400_000, now)
  db.prepare(`INSERT OR REPLACE INTO research_stream_health(lane,last_pulse_ts) VALUES('laserstream',?)`).run(now)
  const candle = db.prepare(`INSERT INTO research_trade_candles
    (chain,token,quote,quote_symbol,day_ts,open,high,low,close,volume_quote,trades,first_trade_ts,last_trade_ts)
    VALUES('solana',?,'So11111111111111111111111111111111111111112','SOL',?,1,1,1,1,10,1,?,?)`)
  for (let i = 30; i >= 1; i--) {
    const day = today - i * 86_400_000
    candle.run(token, day, day + 1_000, day + 1_000)
  }
  assert.equal(getResearch('solana', token).status, 'ready')
  assert.equal(listResearch(new URLSearchParams({ limit: '1' })).backlog, null)
  db.prepare("UPDATE research_holder_state SET state='stale',stream_ok=0,reason='Unverified replay gap.' WHERE mint=?")
    .run(token)
  const stale = getResearch('solana', token)
  assert.equal(stale.holderStrength.score, null)
  assert.equal(stale.holderStrength.retentionPct, null)
  assert.match(stale.holderStrength.reason ?? '', /Unverified replay gap/)
})

test('research rejects invalid detail addresses and malformed cursors', () => {
  assert.equal(validSolanaMint('So11111111111111111111111111111111111111112'), true)
  assert.equal(validSolanaMint('not-a-mint'), false)
  assert.throws(() => getResearch('solana', 'not-a-mint'), /token has not been seen by FTL/)
  assert.throws(() => getResearch('solana', 'x'.repeat(129)), /invalid research address/)
  assert.throws(() => listResearch(new URLSearchParams({ cursor: 'bogus' })), /invalid research cursor/)
})

test('executed single-swap wallet deltas produce real quote candles and duplicate txs do not double count', () => {
  const idl = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '../../server/idl/raydium_cp_swap.json'), 'utf8'))
  const ix = idl.instructions.find((x: any) => x.name === 'swap_base_input')
  assert.ok(ix)
  const wallet = mint(88), token = mint(89)
  db.prepare('INSERT INTO tokens(chain,address,last_ts,events) VALUES(?,?,?,?)').run('solana', token, Date.now(), 1)
  bus.emit('token', 'solana', token)
  const tx = {
    sig: bs58.encode(Buffer.alloc(64, 7)), slot: 12345, keys: [wallet],
    ixs: [{ prog: idl.address ?? idl.metadata.address, accts: [], data: Uint8Array.from(ix.discriminator), n: '0' }],
    pre: [
      { idx: 1, mint: token, owner: wallet, amount: 0n, decimals: 6 },
      { idx: 2, mint: USDC, owner: wallet, amount: 2_000_000n, decimals: 6 },
    ],
    post: [
      { idx: 1, mint: token, owner: wallet, amount: 1_000_000n, decimals: 6 },
      { idx: 2, mint: USDC, owner: wallet, amount: 1_000_000n, decimals: 6 },
    ],
  }
  assert.equal(looksLikeSwap(tx.ixs[0].prog, tx.ixs[0].data), true)
  const raw = __toNTx(bs58.decode(tx.sig), tx.slot, {
    accountKeys: [wallet, tx.ixs[0].prog, mint(90), mint(91)].map(x => bs58.decode(x)),
    instructions: [{ programIdIndex: 1, accounts: new Uint8Array(), data: tx.ixs[0].data }],
  }, [], [], {
    err: null, innerInstructions: [],
    preTokenBalances: [
      { accountIndex: 2, mint: token, owner: wallet, uiTokenAmount: { amount: '0', decimals: 6 } },
      { accountIndex: 3, mint: USDC, owner: wallet, uiTokenAmount: { amount: '2000000', decimals: 6 } },
    ],
    postTokenBalances: [
      { accountIndex: 2, mint: token, owner: wallet, uiTokenAmount: { amount: '1000000', decimals: 6 } },
      { accountIndex: 3, mint: USDC, owner: wallet, uiTokenAmount: { amount: '1000000', decimals: 6 } },
    ],
    preBalances: [], postBalances: [], fee: '0',
  })
  assert.ok(raw) // the cheap Yellowstone gate admits recognized swaps with quote balances
  assert.equal(extractSwap(raw)?.priceQuote, 1)
  const observed = extractSwap(tx, Date.now())
  assert.ok(observed)
  assert.equal(observed.priceQuote, 1)
  assert.equal(extractSwap({ ...tx, ixs: [tx.ixs[0], tx.ixs[0]] }), null)
  ingestSwap({ ...observed, bankId: 'bank-1' })
  assert.equal(getResearch('solana', token).coverage.priceTrades, 0) // processed trades remain provisional
  onResearchSwapStream({ t: 'slot', lane: 'geyser-primary', slot: observed.slot,
    bankId: 'bank-1', status: 'finalized', ts: Date.now() })
  ingestSwap({ ...observed, bankId: 'bank-1' })
  const report = getResearch('solana', token)
  assert.equal(report.priceQuote, 'USDC')
  assert.equal(report.coverage.priceTrades, 1)
  assert.equal(report.priceHistory.length, 1)
  assert.equal(report.priceHistory[0].volumeQuote, 1)
  assert.equal(report.bottoming.signs, null)
})

test('forked processed swaps are discarded and a finalized source can be ingested directly', () => {
  const token = mint(92)
  const quote = USDC
  db.prepare('INSERT INTO tokens(chain,address,last_ts,events) VALUES(?,?,?,?)').run('solana', token, Date.now(), 1)
  bus.emit('token', 'solana', token)
  const sample = {
    id: mint(93), token, quote, quoteSymbol: 'USDC' as const,
    venue: 'test', instruction: 'swap', slot: 90001, bankId: 'fork', ts: Date.now(),
    tokenUi: 1, quoteUi: 2, priceQuote: 2,
  }
  ingestSwap(sample)
  onResearchSwapStream({ t: 'slot', lane: 'geyser-primary', slot: sample.slot,
    bankId: 'canonical', status: 'finalized', ts: Date.now() })
  assert.equal(getResearch('solana', token).coverage.priceTrades, 0)
  ingestSwap({ ...sample, id: mint(94), slot: 90002, bankId: null, finalized: true })
  assert.equal(getResearch('solana', token).coverage.priceTrades, 1)
  ingestSwap({ ...sample, id: mint(95), slot: 90003, bankId: 'processed' })
  ingestSwap({ ...sample, id: mint(95), slot: 90003, bankId: null, finalized: true })
  assert.equal(getResearch('solana', token).coverage.priceTrades, 2) // final feed promotes a processed duplicate
  ingestSwap({ ...sample, id: mint(97), quoteSymbol: 'SOL' as any, finalized: true })
  assert.equal(getResearch('solana', token).coverage.priceTrades, 2) // quote label must match the actual mint
  assert.equal(getResearch('solana', token).bottoming.signs, null)
})

test('Robinhood price samples require finalized exact-time logs and an exact quote label', () => {
  const sample = {
    chain: 'robinhood' as const, id: `0x${'b'.repeat(64)}:3`, token: rh,
    quote: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', quoteSymbol: 'USDG' as const,
    tokenUi: 1, quoteUi: 2, priceQuote: 2, blockNumber: 1234, ts: Date.now(), finalized: false,
  }
  ingestRobinhoodSwap(sample)
  assert.equal(getResearch('robinhood', rh).coverage.priceTrades, 0)
  ingestRobinhoodSwap({ ...sample, finalized: true })
  ingestRobinhoodSwap({ ...sample, finalized: true })
  const report = getResearch('robinhood', rh)
  assert.equal(report.priceQuote, 'USDG')
  assert.equal(report.coverage.priceTrades, 1)
  assert.equal(report.bottoming.signs, null)
  ingestRobinhoodSwap({ ...sample, id: `0x${'c'.repeat(64)}:4`, quoteSymbol: 'ETH' as any, finalized: true })
  assert.equal(getResearch('robinhood', rh).coverage.priceTrades, 1)
  const arbitraryQuote = `0x${'d'.repeat(40)}`
  ingestRobinhoodSwap({ ...sample, id: `0x${'e'.repeat(64)}:5`, quote: arbitraryQuote,
    quoteSymbol: arbitraryQuote, finalized: true })
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM research_swaps WHERE chain='robinhood' AND token=? AND quote=?`)
    .get(rh, arbitraryQuote).n, 1)
  ingestRobinhoodSwap({ ...sample, id: `0x${'f'.repeat(64)}:6`, quote: arbitraryQuote,
    quoteSymbol: 'USDG', finalized: true })
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM research_swaps WHERE chain='robinhood' AND token=? AND quote=?`)
    .get(rh, arbitraryQuote).n, 1)
})

test('bottoming signs require thirty consecutive completed trading days', () => {
  const today = Date.UTC(2026, 9, 8)
  const candles = Array.from({ length: 30 }, (_, i) => ({
    ts: today - (30 - i) * 86_400_000, open: 70, high: i === 0 ? 100 : 72,
    low: 60, close: 68, volumeQuote: 100, trades: 1,
  }))
  candles[20] = { ...candles[20], open: 70, high: 70, low: 48, close: 50, volumeQuote: 1000 }
  candles[24] = { ...candles[24], open: 46, high: 47, low: 40, close: 43, volumeQuote: 100 }
  for (const i of [27, 28]) candles[i] = { ...candles[i], open: 43, high: 44, low: 41, close: 43, volumeQuote: 100 }
  candles[29] = { ...candles[29], open: 43, high: 46, low: 41, close: 45, volumeQuote: 500 }
  assert.equal(computeBottoming(candles.slice(1), today).signs, null)
  const score = computeBottoming(candles, today)
  assert.equal(score.signs, 3)
  assert.equal(score.drawdownPct, -55)
})

test('public bottoming signs fail closed when thirty price days have an unverified stream gap', () => {
  const token = mint(96)
  const today = Math.floor(Date.now() / 86_400_000) * 86_400_000
  db.prepare('INSERT INTO tokens(chain,address,last_ts,events) VALUES(?,?,?,?)').run('solana', token, today, 1)
  bus.emit('token', 'solana', token)
  const add = db.prepare(`INSERT INTO research_trade_candles
    (chain,token,quote,quote_symbol,day_ts,open,high,low,close,volume_quote,trades,first_trade_ts,last_trade_ts)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  for (let i = 0; i < 30; i++) {
    const ts = today - (30 - i) * 86_400_000
    add.run('solana', token, USDC, 'USDC', ts, 70, 100, 50, 60, 100, 1, ts, ts)
  }
  assert.equal(getResearch('solana', token).bottoming.signs, null)
  onResearchSwapStream({ t: 'open', lane: 'laserstream', token, ts: today - 30 * 86_400_000 })
  onResearchSwapStream({ t: 'pulse', lane: 'laserstream', ts: Date.now() })
  assert.notEqual(getResearch('solana', token).bottoming.signs, null)
  onResearchSwapStream({ t: 'close', lane: 'laserstream', token, ts: today - 10 * 86_400_000 })
  assert.equal(getResearch('solana', token).bottoming.signs, null)
  onResearchSwapStream({ t: 'resume', lane: 'laserstream', token, ts: Date.now() })
  assert.notEqual(getResearch('solana', token).bottoming.signs, null) // replay proved the interval complete
  onResearchSwapStream({ t: 'gap', lane: 'laserstream', token, ts: today - 10 * 86_400_000,
    reason: 'replay unavailable' })
  assert.equal(getResearch('solana', token).bottoming.signs, null)
})
