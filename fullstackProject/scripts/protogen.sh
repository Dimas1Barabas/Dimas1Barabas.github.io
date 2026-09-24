#!/usr/bin/env bash
# Кодоген gRPC-контрактов: proto/*.proto -> services/recommendation-service/internal/pb/*.pb.go
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
buf generate
echo "OK: proto -> services/recommendation-service/internal/pb/"

# копия контракта для NestJS-стороны: proto-loader читает .proto в рантайме
cp "$root/proto/recommendation.proto" \
   "$root/apps/api/src/recommendations/proto/recommendation.proto"
echo "OK: proto -> apps/api/src/recommendations/proto/"
