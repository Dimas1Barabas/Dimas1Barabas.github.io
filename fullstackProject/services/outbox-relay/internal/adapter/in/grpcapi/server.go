// Package grpcapi — входящий адаптер: gRPC-сервер Курьера. API звонит
// Notify после COMMIT транзакции с outbox-записью (ускоритель латентности),
// витрину Stats читают HTTP-зеркало и мониторинг.
package grpcapi

import (
	"context"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"outbox-relay/internal/adapter/out/prom"
	pb "outbox-relay/internal/pb"
	"outbox-relay/internal/service"
)

// Server реализует сгенерированный интерфейс; Unimplemented даёт фору
// будущим методам контракта.
type Server struct {
	pb.UnimplementedOutboxRelayServer
	relay   *service.Relay
	metrics *prom.Metrics
}

func New(relay *service.Relay, metrics *prom.Metrics) *Server {
	return &Server{relay: relay, metrics: metrics}
}

// Notify — разбудить тик. Слияние сигналов (тику уже велели) — НЕ ошибка:
// accepted=false, доставка не пострадала.
func (s *Server) Notify(_ context.Context, _ *pb.NotifyRequest) (*pb.NotifyResponse, error) {
	if s.relay.Notify() {
		s.metrics.NotifyAccepted()
		return &pb.NotifyResponse{Accepted: true}, nil
	}
	s.metrics.NotifyCoalesced()
	return &pb.NotifyResponse{Accepted: false}, nil
}

// Stats — витрина: pending-хвост, возраст старейшей, счётчики процесса.
func (s *Server) Stats(ctx context.Context, _ *pb.StatsRequest) (*pb.StatsResponse, error) {
	st, err := s.relay.Stats(ctx)
	if err != nil {
		return nil, status.Error(codes.Internal, "хранилище outbox недоступно")
	}
	var oldestMs int64
	if !st.OldestPending.IsZero() {
		oldestMs = time.Since(st.OldestPending).Milliseconds()
	}
	return &pb.StatsResponse{
		Pending:         st.Pending,
		OldestPendingMs: oldestMs,
		PublishedTotal:  st.PublishedTotal,
		FailedAttempts:  st.FailedAttempts,
	}, nil
}
