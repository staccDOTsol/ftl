const path = require('node:path')
const { getDefaultConfig } = require('expo/metro-config')

const config = getDefaultConfig(__dirname)

// tslib 1.x exposes an "import" entry that defaults-imports its CommonJS
// bundle. Metro's web interop leaves that default undefined. Resolve each
// dependency's own ESM helper file instead, keeping the fix local to web.
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (platform === 'web' && moduleName === 'tslib') {
    const main = require.resolve('tslib', { paths: [path.dirname(context.originModulePath)] })
    return { type: 'sourceFile', filePath: path.join(path.dirname(main), 'tslib.es6.js') }
  }
  return context.resolveRequest(context, moduleName, platform)
}

module.exports = config
