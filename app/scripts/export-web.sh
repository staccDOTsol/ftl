#!/bin/sh
# Static web export for Vercel. Vercel's CLI never uploads node_modules folders,
# and Expo writes font assets under assets/node_modules, so move them and repoint the bundle.
set -e
cd "$(dirname "$0")/.."
rm -rf dist
EXPO_PUBLIC_API_URL=${EXPO_PUBLIC_API_URL:-https://api.liquidityxyz.fun} npx expo export -p web
mv dist/assets/node_modules dist/assets/vendor
find dist/_expo -name '*.js' -exec sed -i '' 's#/assets/node_modules/#/assets/vendor/#g' {} +
cp vercel.json dist/
