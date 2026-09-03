FROM golang:1.24-alpine AS build
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /ticket-worker .

FROM alpine:3.21
COPY --from=build /ticket-worker /ticket-worker
EXPOSE 8081
ENTRYPOINT ["/ticket-worker"]
