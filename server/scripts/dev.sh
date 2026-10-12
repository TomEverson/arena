#!/usr/bin/env sh
# Run the server under air (hot reload). air is installed by `go install`
# into GOPATH/bin, which is often not on PATH.
set -e
PATH="$PATH:$(go env GOPATH)/bin"
if ! command -v air >/dev/null 2>&1; then
  echo "air not found. Install it: go install github.com/air-verse/air@latest" >&2
  exit 1
fi
# Extra arguments are passed to the server binary, e.g. ./scripts/dev.sh --fake-latency=80ms
if [ "$#" -gt 0 ]; then
  exec air -c .air.toml -- "$@"
fi
exec air -c .air.toml
