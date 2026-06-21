#!/usr/bin/env bash
# Publish the true402 MCP server to Smithery as a stdio MCPB bundle.
# Requires SMITHERY_API_KEY in the environment.
#   SMITHERY_API_KEY=… ./mcpb/publish.sh
# The bundle is thin (runs `npx -y @true402.dev/mcp-server`), so each npm release is picked up
# automatically — re-run only when the manifest/config changes.
set -euo pipefail
cd "$(dirname "$0")/.."
npm run build
VER=$(node -p "require('./package.json').version")
WORK=$(mktemp -d)
cp -r dist package.json README.md mcpb/manifest.json "$WORK"/
node -e "const f=process.argv[1],m=require(f);m.version='$VER';require('fs').writeFileSync(f,JSON.stringify(m,null,2))" "$WORK/manifest.json"
npx -y @anthropic-ai/mcpb@latest pack "$WORK" "$WORK/true402.mcpb"
npx -y @smithery/cli mcp publish "$WORK/true402.mcpb" -n true402/mcp-server
rm -rf "$WORK"
