# multi-stage: сборка в golang, рантайм — alpine без тулчейна
FROM golang:1.25-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /pricing ./cmd/pricing

# tzdata — правила времени суток Тарификатор считает в локальном времени
# кинотеатра (TZ окружения, compose задаёт Europe/Moscow)
FROM alpine:3.21
COPY --from=build /pricing /pricing
RUN apk add --no-cache tzdata
EXPOSE 8088 8089
ENTRYPOINT ["/pricing"]
