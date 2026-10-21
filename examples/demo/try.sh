#!/usr/bin/env bash
# A 60-second tour of stickypatch on a pretend CLI. Touches nothing outside a temp dir.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
sp() { node "$here/../../bin/stickypatch.js" "$@"; }
work="$(mktemp -d)"
export STICKYPATCH_HOME="$work/.stickypatch"
cp -R "$here/v1" "$work/installed"            # pretend: npm i -g weather-cli@1.0.0
cd "$work"
step() { printf '\n\033[1;36m$ %s\033[0m\n' "$*"; }
note() { printf '\033[2m# %s\033[0m\n' "$*"; }
edit() { node -e 'const fs=require("fs");const [f,a,b]=process.argv.slice(1);fs.writeFileSync(f,fs.readFileSync(f,"utf8").replace(a,b))' "$@"; }

step stickypatch init weather-cli
sp init weather-cli --dir installed >/dev/null && echo "✔ tracking weather-cli@1.0.0"

note "You hack the installed CLI three times, capturing each fix:"
edit installed/src/fetch.js 'const timeoutMs = 5000;' 'const timeoutMs = 30000;'
sp capture installed/src/fetch.js --id longer-timeout --why "slow hotel wifi" --pristine "$here/v1" --dir installed | head -1
edit installed/src/fetch.js 'const retries = 1;' 'const retries = 3;'
sp capture installed/src/fetch.js --id more-retries --why "flaky API" --pristine "$here/v1" --dir installed | head -1
edit installed/src/fetch.js "  return get('https://telemetry.example.com/collect', { body: event });" '  return null; // no telemetry'
sp capture installed/src/fetch.js --id no-telemetry --why "privacy" --pristine "$here/v1" --dir installed | head -1
# Tell stickypatch what "upstream fixed it" would look like for more-retries:
node -e 'const fs=require("fs");const c=JSON.parse(fs.readFileSync("stickypatch.json"));c.patches.find(p=>p.id==="more-retries").upstream=[{file:"src/fetch.js",contains:"WEATHER_RETRIES"}];fs.writeFileSync("stickypatch.json",JSON.stringify(c,null,2))'

note "Then: npm update -g weather-cli — 1.1.0 silently wipes all three."
rm -rf installed && cp -R "$here/v2" installed

step stickypatch status
sp status --dir installed || true

step stickypatch review '> review.md'
sp review --dir installed > review.md
echo "wrote review.md ($(wc -l < review.md | tr -d ' ') lines) — hand it to Claude / Codex / ChatGPT"

step stickypatch retire more-retries
sp retire more-retries --reason "1.1.0 reads WEATHER_RETRIES" --dir installed

step stickypatch apply --approve --partial
sp apply --approve --partial --dir installed

step stickypatch status
sp status --dir installed || true
printf '\n\033[2m(sandbox: %s)\033[0m\n' "$work"
