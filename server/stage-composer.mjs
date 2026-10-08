// Stage the versioned compatibility boundary beside the rescued binary.
// Usage: node server/stage-composer.mjs /absolute/rescue/deploy-context
import { copyFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const target = process.argv[2]
if (!target || !path.isAbsolute(target) || !existsSync(path.join(target, 'composer')))
  throw new Error('Supply the existing rescued Composer deploy-context directory')
copyFileSync(fileURLToPath(new URL('./src/solana/composer-rpc-compat.mjs', import.meta.url)), path.join(target, 'rpc-compat.mjs'))
console.log('Staged Composer V1 compatibility boundary')
