# multi-stage: сборка в golang, рантайм — alpine без тулчейна
FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /analytics ./cmd/analytics

FROM alpine:3.21
COPY --from=build /analytics /analytics
EXPOSE 8092
ENTRYPOINT ["/analytics"]
