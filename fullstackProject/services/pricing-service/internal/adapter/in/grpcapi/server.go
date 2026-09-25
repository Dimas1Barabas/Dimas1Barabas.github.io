// Package grpcapi — входящий адаптер: gRPC-сервер Тарификатора.
// API звонит сюда при создании брони и для витрины цены сеанса.
package grpcapi

import (
	"context"
	"errors"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"pricing-service/internal/domain"
	pb "pricing-service/internal/pb"
	"pricing-service/internal/service"
)

// Server реализует сгенерированный интерфейс; Unimplemented даёт фору
// будущим методам контракта.
type Server struct {
	pb.UnimplementedPricingServer
	svc *service.Pricer
}

func New(svc *service.Pricer) *Server {
	return &Server{svc: svc}
}

// Quote: цена места сеанса с раскладкой факторов. Мусор в запросе
// (неразобранная дата, неположительная база/ёмкость) — InvalidArgument;
// сбой хранилища спроса — Internal, вызывающий ответит fallback'ом.
func (s *Server) Quote(ctx context.Context, req *pb.QuoteRequest) (*pb.QuoteResponse, error) {
	sessionAt, err := parseSessionAt(req.GetSessionAt())
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, err.Error())
	}
	if req.GetSessionId() == "" {
		return nil, status.Error(codes.InvalidArgument, "sessionId обязателен")
	}
	quote, err := s.svc.Quote(ctx, service.QuoteRequest{
		SessionID:    req.GetSessionId(),
		SessionAt:    sessionAt,
		BasePriceRub: int(req.GetBasePriceRub()),
		Capacity:     int(req.GetCapacity()),
	})
	if err != nil {
		if errors.Is(err, domain.ErrInvalidQuote) {
			return nil, status.Error(codes.InvalidArgument, err.Error())
		}
		return nil, status.Error(codes.Internal, "хранилище спроса недоступно")
	}
	factors := make([]*pb.PriceFactor, 0, len(quote.Factors))
	for _, f := range quote.Factors {
		factors = append(factors, &pb.PriceFactor{
			Code:    f.Code,
			Label:   f.Label,
			Percent: int32(f.Percent),
		})
	}
	return &pb.QuoteResponse{
		PriceRub:     int32(quote.PriceRub),
		BasePriceRub: int32(quote.BasePriceRub),
		Factors:      factors,
		Occupied:     int32(quote.Occupied),
		Capacity:     int32(quote.Capacity),
	}, nil
}

// parseSessionAt: пустая или неразбираемая дата — отказ на границе,
// до домена такое не доходит.
func parseSessionAt(v string) (time.Time, error) {
	if v == "" {
		return time.Time{}, errors.New("sessionAt обязателен")
	}
	t, err := time.Parse(time.RFC3339, v)
	if err != nil {
		return time.Time{}, errors.New("sessionAt ожидается в RFC3339")
	}
	return t, nil
}
