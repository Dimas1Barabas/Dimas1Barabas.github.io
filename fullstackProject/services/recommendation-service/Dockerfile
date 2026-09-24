# multi-stage: сборка в golang, рантайм — alpine без тулчейна
FROM golang:1.25-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /recommendation ./cmd/recommendation

FROM alpine:3.21
COPY --from=build /recommendation /recommendation
EXPOSE 8084 8085
ENTRYPOINT ["/recommendation"]
