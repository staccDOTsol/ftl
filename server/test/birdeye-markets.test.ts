import assert from 'node:assert/strict'
import { test } from 'node:test'
import { discoverPools, venueOfSource } from '../src/solana/birdeye-markets.ts'

test('birdeye source names map onto venues we can already build', () => {
  assert.equal(venueOfSource('Raydium Clamm'), 'raydium-clmm')
  assert.equal(venueOfSource('Raydium'), null)
  assert.equal(venueOfSource('Orca Whirlpool'), 'orca')
  assert.equal(venueOfSource('Meteora DLMM'), 'meteora-dlmm')
  assert.equal(venueOfSource('Tesserav'), null)
})

test('discoverPools keeps only the asked pair and a supported venue', async () => {
  const prev = process.env.BIRDEYE_API_KEY
  process.env.BIRDEYE_API_KEY = 'test-key'
  const sol = 'So11111111111111111111111111111111111111112'
  const usdt = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'
  const usdc = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
  const fetcher: typeof fetch = async () => new Response(JSON.stringify({
    data: { items: [
      { address: '7XawhbbxtsRcQA8KTkHT9f9nc6d69UwqCDh6U5EEbEmX', source: 'Raydium', liquidity: 9_000_000,
        base: { address: sol }, quote: { address: usdt } },
      { address: '3nMFwZXwY1s1M5s8vYAHqd4wGs4iSxXE4LRoUMMYqEgF', source: 'Raydium Clamm', liquidity: 800_000,
        base: { address: sol }, quote: { address: usdt } },
      { address: 'HRYEjwdo3bZ1TpXKWKcezqiwSV2Ywuh4LxMa2PzoCnG6', source: 'Meteora DLMM', liquidity: 5_000_000,
        base: { address: sol }, quote: { address: usdc } },
    ] },
  }), { status: 200, headers: { 'content-type': 'application/json' } })
  try {
    const rows = await discoverPools(sol, usdt, fetcher)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].venue, 'raydium-clmm')
    assert.equal(rows[0].address, '3nMFwZXwY1s1M5s8vYAHqd4wGs4iSxXE4LRoUMMYqEgF')
  } finally {
    if (prev === undefined) delete process.env.BIRDEYE_API_KEY
    else process.env.BIRDEYE_API_KEY = prev
  }
})
