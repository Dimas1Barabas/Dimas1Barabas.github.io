# multi-stage: сборка в golang, рантайм — alpine без тулчейна
FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /flags ./cmd/flags

# tzdata не нужен: вердикты флагов от часов не зависят
FROM alpine:3.21
COPY --from=build /flags /flags
EXPOSE 8095 8096
ENTRYPOINT ["/flags"]
