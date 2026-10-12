#!/usr/bin/env sh
# go vet always; golangci-lint if installed (skipped gracefully otherwise).
set -e
PATH="$PATH:$(go env GOPATH)/bin"
go vet ./...
test -z "$(gofmt -l .)" || { echo "gofmt needed on:"; gofmt -l .; exit 1; }
if command -v golangci-lint >/dev/null 2>&1; then
  golangci-lint run ./...
else
  echo "golangci-lint not installed: skipping (go vet + gofmt still ran)"
fi
