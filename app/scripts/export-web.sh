#!/bin/sh
# Static web export for Vercel. Vercel's CLI never uploads node_modules folders,
# and Expo writes font assets under assets/node_modules, so move them and repoint the bundle.
set -e
cd "$(dirname "$0")/.."
export EXPO_PUBLIC_API_URL=${EXPO_PUBLIC_API_URL:-https://api.liquidityxyz.fun}
case "$EXPO_PUBLIC_API_URL" in
  http://localhost*|https://localhost*|http://127.0.0.1*|https://127.0.0.1*|http://0.0.0.0*|https://0.0.0.0*)
    echo "Refusing to export a public web build with a loopback API URL" >&2
    exit 1
    ;;
esac
rm -rf dist
npx expo export -p web --clear
node -e 'const fs=require("node:fs");const base="dist/_expo/static/js/web";const entries=fs.readdirSync(base).filter(name=>name.startsWith("entry-")&&name.endsWith(".js"));if(entries.length!==1)throw Error("Expected one web entry bundle");const source=fs.readFileSync(`${base}/${entries[0]}`,"utf8");const start=source.indexOf("Object.defineProperty(e,\"API_URL\"");const module=source.slice(start,start+1500);if(start<0||!module.includes(`const s=${JSON.stringify(process.env.EXPO_PUBLIC_API_URL)}.replace`))throw Error("Web API URL does not match the configured endpoint");'
mv dist/assets/node_modules dist/assets/vendor
find dist/_expo -name '*.js' -exec sed -i '' 's#/assets/node_modules/#/assets/vendor/#g' {} +
cp vercel.json dist/
if [ -f .vercel/project.json ]; then
  mkdir -p dist/.vercel
  cp .vercel/project.json dist/.vercel/project.json
fi
