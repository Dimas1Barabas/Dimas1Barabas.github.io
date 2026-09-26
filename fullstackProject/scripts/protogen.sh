#!/usr/bin/env bash
# Кодоген gRPC-контрактов: proto/*.proto -> services/*/internal/pb/*.pb.go
# (какой контракт в какой сервис — разводит include в proto/buf.gen.yaml)
#
# Инструменты (buf + плагины protoc-gen-go*) ставятся через `go install`
# в GOPATH/bin при отсутствии — protoc-бинарь не нужен вовсе.
# Сгенерированный код КОММИТИМ: это исходники, CI кодоген не запускает.
#
# Запуск из корня fullstackProject: scripts/protogen.sh
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
gopath="$(go env GOPATH)"
gobin="${gopath//\\//}/bin"
export PATH="$gobin:$PATH"

command -v protoc-gen-go >/dev/null || go install google.golang.org/protobuf/cmd/protoc-gen-go@latest
command -v protoc-gen-go-grpc >/dev/null || go install google.golang.org/grpc/cmd/protoc-gen-go-grpc@latest
command -v buf >/dev/null || go install github.com/bufbuild/buf/cmd/buf@latest

cd "$root/proto"
buf generate --template buf.gen.yaml --path recommendation.proto
buf generate --template buf.gen.reminder.yaml --path reminder.proto
buf generate --template buf.gen.pricing.yaml --path pricing.proto
buf generate --template buf.gen.ratelimiter.yaml --path ratelimiter.proto
echo "OK: proto -> services/*/internal/pb/"

# копии контрактов для NestJS-стороны: proto-loader читает .proto в рантайме
cp "$root/proto/recommendation.proto" \
   "$root/apps/api/src/recommendations/proto/recommendation.proto"
mkdir -p "$root/apps/api/src/reminders/proto"
cp "$root/proto/reminder.proto" \
   "$root/apps/api/src/reminders/proto/reminder.proto"
mkdir -p "$root/apps/api/src/pricing/proto"
cp "$root/proto/pricing.proto" \
   "$root/apps/api/src/pricing/proto/pricing.proto"
mkdir -p "$root/apps/api/src/ratelimiter/proto"
cp "$root/proto/ratelimiter.proto" \
   "$root/apps/api/src/ratelimiter/proto/ratelimiter.proto"
echo "OK: proto -> apps/api/src/{recommendations,reminders,pricing,ratelimiter}/proto/"
