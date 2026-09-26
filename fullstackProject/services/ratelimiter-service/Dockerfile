# multi-stage: сборка в golang, рантайм — alpine без тулчейна
FROM golang:1.25-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /ratelimiter ./cmd/ratelimiter

# tzdata не нужен: правила лимитов от часов не зависят
FROM alpine:3.21
COPY --from=build /ratelimiter /ratelimiter
EXPOSE 8090 8091
ENTRYPOINT ["/ratelimiter"]
