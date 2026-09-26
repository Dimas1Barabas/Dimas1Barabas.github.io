// Package grpcapi — входящий адаптер: gRPC-сервер «Привратника».
// Гварды NestJS API звонят сюда перед допуском лимитируемого действия.
package grpcapi

import (
	"context"
	"errors"
	"math"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"ratelimiter-service/internal/domain"
	pb "ratelimiter-service/internal/pb"
	"ratelimiter-service/internal/service"
)

// Server реализует сгенерированный интерфейс; Unimplemented даёт фору
// будущим методам контракта.
type Server struct {
	pb.UnimplementedRateLimiterServer
	svc       *service.Limiter
	policies  map[domain.Action]domain.Policy // для limit/capacity в ответе
}

func New(svc *service.Limiter) *Server {
	return &Server{svc: svc, policies: svc.Policies()}
}

// Check: снять токен корзины. Пустые поля — InvalidArgument; действие
// вне таблицы политик — InvalidArgument (конфигурационная ошибка
// вызывающего, не повод для fail-open); сбой хранилища — Internal.
// Сам отказ (allowed=false) — штатный ответ, не ошибка RPC.
func (s *Server) Check(ctx context.Context, req *pb.CheckRateRequest) (*pb.CheckRateResponse, error) {
	if req.GetAction() == "" {
		return nil, status.Error(codes.InvalidArgument, "action обязателен")
	}
	if req.GetKey() == "" {
		return nil, status.Error(codes.InvalidArgument, "key обязателен")
	}

	d, err := s.svc.Check(ctx, req.GetAction(), req.GetKey())
	if err != nil {
		if errors.Is(err, domain.ErrUnknownAction) {
			return nil, status.Error(codes.InvalidArgument, err.Error())
		}
		return nil, status.Error(codes.Internal, "хранилище корзин недоступно")
	}

	p := s.policies[domain.Action(req.GetAction())]
	return &pb.CheckRateResponse{
		Allowed:      d.Allowed,
		RetryAfterMs: int32(d.RetryAfter.Milliseconds()),
		Remaining:    int32(math.Floor(d.Remaining)),
		Limit:        int32(p.LimitPerMin),
		Capacity:     int32(p.Capacity),
	}, nil
}
