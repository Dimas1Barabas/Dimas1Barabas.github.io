FROM golang:1.24-alpine AS build
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /notification ./cmd/notification

FROM alpine:3.21
COPY --from=build /notification /notification
EXPOSE 8080
ENTRYPOINT ["/notification"]
