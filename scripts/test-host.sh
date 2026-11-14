#!/usr/bin/env bash
set -euo pipefail
project_dir="$(cd "$(dirname "$0")/.." && pwd)"
host_dir="${1:?Usage: scripts/test-host.sh /path/to/new-api-v1.0.0-rc.50}"
test_target="$host_dir/pkg/jsplugin/kiro4newapi_contract_test.go"
relay_target="$host_dir/relay/channel/providerplugin/kiro4newapi_relay_test.go"
if [[ -e "$test_target" || -e "$relay_target" ]]; then
  echo 'Refusing to overwrite an existing host test' >&2
  exit 1
fi
trap 'rm -f "$test_target" "$relay_target"' EXIT
cp "$project_dir/test/host_contract_test.go" "$test_target"
cp "$project_dir/test/host_relay_test.go" "$relay_target"
cd "$host_dir"
KIRO_PLUGIN_FILE="$project_dir/plugin.js" go test ./pkg/jsplugin ./relay/channel/providerplugin -run '^TestKiro4NewAPI(Contracts|Relay)$' -count=1 -v
