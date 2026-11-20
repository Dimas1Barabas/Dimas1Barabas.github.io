// Package grpcapi — входящий адаптер: gRPC-сервер «Детектива».
// Чекаут NestJS API звонит сюда до создания брони, админ-витрина —
// за решением человека по брони из очереди ревью.
package grpcapi

import (
	"context"
	"errors"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"detective-service/internal/adapter/out/prom"
	"detective-service/internal/domain"
	pb "detective-service/internal/pb"
	"detective-service/internal/service"
)

// Server реализует сгенерированный интерфейс; Unimplemented даёт фору
// будущим методам контракта.
type Server struct {
	pb.UnimplementedDetectiveServer
	svc     *service.Detective
	metrics *prom.Metrics
}

func New(svc *service.Detective, metrics *prom.Metrics) *Server {
	return &Server{svc: svc, metrics: metrics}
}

// Score: решение по фактам брони. Пустые ключи — InvalidArgument;
// verdict block/review — штатные ответы, не ошибки RPC (вызывающий
// гасит падение сервиса fail-open'ом у себя). Сбой хранилища — Internal.
func (s *Server) Score(ctx context.Context, req *pb.ScoreRequest) (*pb.ScoreResponse, error) {
	if req.GetBookingId() == "" {
		return nil, status.Error(codes.InvalidArgument, "booking_id обязателен")
	}
	if req.GetUserId() == "" {
		return nil, status.Error(codes.InvalidArgument, "user_id обязателен")
	}

	startedAt := time.Now()
	rec, err := s.svc.Score(ctx, domain.Facts{
		BookingID:      req.GetBookingId(),
		UserID:         req.GetUserId(),
		SessionID:      req.GetSessionId(),
		SeatsCount:     int(req.GetSeatsCount()),
		TotalRub:       int(req.GetTotalRub()),
		AccountAgeDays: int(req.GetAccountAgeDays()),
		Bookings24h:    int(req.GetBookings24H()),
		Cancels24h:     int(req.GetCancels24H()),
		Failed24h:      int(req.GetFailed24H()),
	})
	if err != nil {
		s.metrics.ScoreError()
		return nil, status.Error(codes.Internal, "хранилище решений недоступно")
	}
	s.metrics.Score(string(rec.Verdict), time.Since(startedAt).Seconds())

	return &pb.ScoreResponse{
		Verdict: string(rec.Verdict),
		Score:   int32(rec.Score),
		Reasons: rec.Reasons,
	}, nil
}

// Resolve: решение человека по брони из очереди ревью. Мусорное
// действие — InvalidArgument; решение не найдено — NotFound; уже
// закрыто — FailedPrecondition (гонка двух админов); сбой — Internal.
func (s *Server) Resolve(ctx context.Context, req *pb.ResolveRequest) (*pb.ResolveResponse, error) {
	if req.GetBookingId() == "" {
		return nil, status.Error(codes.InvalidArgument, "booking_id обязателен")
	}
	if req.GetResolvedBy() == "" {
		return nil, status.Error(codes.InvalidArgument, "resolved_by обязателен")
	}

	rec, err := s.svc.Resolve(ctx, req.GetBookingId(), req.GetAction(), req.GetResolvedBy())
	if err != nil {
		switch {
		case errors.Is(err, domain.ErrUnknownResolveAction):
			return nil, status.Error(codes.InvalidArgument, err.Error())
		case errors.Is(err, domain.ErrDecisionNotFound):
			return nil, status.Error(codes.NotFound, err.Error())
		case errors.Is(err, domain.ErrAlreadyResolved):
			return nil, status.Error(codes.FailedPrecondition, err.Error())
		default:
			s.metrics.ResolveError()
			return nil, status.Error(codes.Internal, "хранилище решений недоступно")
		}
	}
	s.metrics.Resolve(string(rec.Status))
	return &pb.ResolveResponse{Resolved: true, Status: string(rec.Status)}, nil
}
