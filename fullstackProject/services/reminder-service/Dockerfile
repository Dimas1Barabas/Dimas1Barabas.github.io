# multi-stage: сборка в golang, рантайм — alpine без тулчейна
FROM golang:1.25-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /reminder ./cmd/reminder

FROM alpine:3.21
COPY --from=build /reminder /reminder
EXPOSE 8086 8087
ENTRYPOINT ["/reminder"]
