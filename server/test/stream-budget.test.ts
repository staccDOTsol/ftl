import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { StreamPayloadBudget } from '../src/solana/stream-budget.ts'

test('estimated hourly payload cap survives restart and opens after the window', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ftl-stream-budget-'))
  try {
    const t = 60_000 * 100
    const budget = new StreamPayloadBudget(dir, 'geyser-primary', 100)
    budget.observe(10, t)
    for (let i = 0; i < 8; i++) budget.observe(null, t + i + 1)
    assert.equal(budget.status(t + 9).circuitOpenUntil, undefined)
    const tripped = budget.observe(null, t + 10)
    assert.equal(tripped.estimatedWindowPayloadBytes, 100)
    assert.equal(tripped.circuitOpenUntil, t + 3_600_000)

    const restarted = new StreamPayloadBudget(dir, 'geyser-primary', 100)
    assert.equal(restarted.status(t + 11).circuitOpenUntil, tripped.circuitOpenUntil)
    assert.equal(restarted.status(t + 3_600_000).circuitOpenUntil, undefined)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('zero budget limit records usage without pausing the stream', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ftl-stream-budget-'))
  try {
    const budget = new StreamPayloadBudget(dir, 'geyser-primary', 0)
    for (let i = 0; i < 100; i++) budget.observe(i === 0 ? 1_000 : null, 60_000 * 100 + i)
    assert.equal(budget.status(60_000 * 100 + 101).budgetLimitBytes, 0)
    assert.equal(budget.status(60_000 * 100 + 101).estimatedWindowPayloadBytes, 100_000)
    assert.equal(budget.status(60_000 * 100 + 101).circuitOpenUntil, undefined)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
