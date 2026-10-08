import test from 'node:test'
import assert from 'node:assert/strict'
import { Interface, keccak256 } from 'ethers'
import { encodeV4Buy } from '../src/robinhood/v4-quote.ts'

test('direct Robinhood V4 swap calldata matches the official 2.1.2 SDK encoding', () => {
  // Fixture generated with @uniswap/v4-sdk 2.4.1 (URVersion.V2_1_1) and
  // @uniswap/universal-router-sdk 5.15.0 (V4_SWAP command).
  const calldata = encodeV4Buy({
    currency0: '0x0000000000000000000000000000000000000000',
    currency1: '0x98c40722a3c20340cd339fc70034ad2780a0f211',
    fee: 10000, tickSpacing: 200,
    hooks: '0x0000000000000000000000000000000000000000',
    id: '0x00ee9f42675cbedde1fcfee6e5bba3f12c42796cbaab340c0a3de82af2358606',
  }, 1000000000000000n, 10154961540515432113307n, 1800000000)
  assert.equal(keccak256(calldata), '0x709d20baa2e3a383063bc9364cd19f88f80d1b6fbd2f79538787f3ce3ffe8a50')
  const execute = new Interface(['function execute(bytes commands,bytes[] inputs,uint256 deadline) payable'])
  const [commands, inputs, deadline] = execute.decodeFunctionData('execute', calldata)
  assert.equal(commands, '0x10')
  assert.equal(deadline, 1800000000n)
  assert.equal(inputs.length, 1)
})
