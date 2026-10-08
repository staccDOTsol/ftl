import test from 'node:test'
import assert from 'node:assert/strict'

const keys = [
  'DRPC_GEYSER', 'TRITON_GEYSER', 'TRITON_DESHRED', 'TRITON_PRECONFS',
  'TRITON_GRPC_URL', 'TRITON_X_TOKEN', 'TRITON_PRECONFS_TOKEN', 'TRITON_PRECONFS_REGIONS',
  'YELLOWSTONE_GRPC_URL', 'YELLOWSTONE_X_TOKEN', 'YELLOWSTONE_MAX_MIB_PER_HOUR', 'SOLANA_RPC_URL', 'SOLANA_DAS_URL',
  'HELIUS_LASERSTREAM_MAX_MIB_PER_HOUR',
]

test('billable Solana streams require explicit configuration', async () => {
  const saved = new Map(keys.map(k => [k, process.env[k]]))
  try {
    for (const k of keys) delete process.env[k]
    process.env.TRITON_GRPC_URL = 'https://example.invalid'
    process.env.TRITON_X_TOKEN = 'test-only-token'

    const legacy = (await import('../src/config.ts?cost-config=legacy')).config
    assert.equal(legacy.tritonGeyser, false)
    assert.equal(legacy.tritonDeshred, false)
    assert.equal(legacy.tritonPreconfs, false)
    assert.equal(legacy.preconfsToken, undefined)
    assert.deepEqual(legacy.preconfsRegions, [])
    assert.equal(legacy.drpcGeyser, false)
    assert.equal(legacy.yellowstoneGrpcUrl, undefined)
    assert.equal(legacy.yellowstoneMaxPayloadBytesPerHour, 0) // telemetry-only default
    assert.equal(legacy.heliusLaserstreamMaxPayloadBytesPerHour, 0)

    process.env.YELLOWSTONE_GRPC_URL = 'https://example.invalid'
    process.env.YELLOWSTONE_X_TOKEN = 'test-only-primary-token'
    process.env.YELLOWSTONE_MAX_MIB_PER_HOUR = '25'
    process.env.TRITON_PRECONFS = '1'
    process.env.TRITON_PRECONFS_TOKEN = 'test-only-preconfs-token'
    process.env.TRITON_PRECONFS_REGIONS = 'Harmonic:EWR,bam:ewr'
    process.env.SOLANA_RPC_URL = 'https://example.invalid/?key=test-only-rpc-key'
    process.env.SOLANA_DAS_URL = 'https://test-only-fast-mainnet.helius-rpc.com/?api-key=test-only-das-key'
    const selectedModule = await import('../src/config.ts?cost-config=selected')
    const selected = selectedModule.config
    assert.equal(selected.yellowstoneGrpcUrl, 'https://example.invalid')
    assert.equal(selected.yellowstoneXToken, 'test-only-primary-token')
    assert.equal(selected.yellowstoneMaxPayloadBytesPerHour, 25 * 1024 * 1024)
    assert.equal(selected.tritonPreconfs, true)
    assert.equal(selected.preconfsToken, 'test-only-preconfs-token')
    assert.deepEqual(selected.preconfsRegions, ['harmonic:ewr', 'bam:ewr'])
    assert.equal(selected.solanaRpc, 'https://example.invalid/?key=test-only-rpc-key')
    assert.equal(selected.solanaDasRpc, 'https://test-only-fast-mainnet.helius-rpc.com/?api-key=test-only-das-key')
    assert.equal(selectedModule.redact('test-only-rpc-key test-only-das-key test-only-fast-mainnet.helius-rpc.com'), '*** *** ***')
  } finally {
    for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  }
})
