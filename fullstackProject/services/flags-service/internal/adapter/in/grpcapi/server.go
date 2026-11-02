// Package grpcapi — входящий адаптер: gRPC-сервер «Суфлёра».
// Гварды NestJS API спрашивают вердикты (Evaluate), кэш состояний
// берёт снимок (ListFlags), админка правит (UpsertFlag/DeleteFlag).
package grpcapi

import (
	"context"
	"errors"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"flags-service/internal/adapter/out/prom"
	"flags-service/internal/domain"
	pb "flags-service/internal/pb"
	"flags-service/internal/service"
)

// Server реализует сгенерированный интерфейс; Unimplemented даёт фору
// будущим методам контракта.
type Server struct {
	pb.UnimplementedFlagsServer
	svc     *service.Flags
	metrics *prom.Metrics
}

func New(svc *service.Flags, metrics *prom.Metrics) *Server {
	return &Server{svc: svc, metrics: metrics}
}

// Evaluate: вердикт флага для сущности. Пустой key — InvalidArgument;
// отсутствие флага — штатный вердикт not_found, не ошибка RPC;
// сбой хранилища — Internal.
func (s *Server) Evaluate(ctx context.Context, req *pb.EvaluateRequest) (*pb.EvaluateResponse, error) {
	if req.GetKey() == "" {
		return nil, status.Error(codes.InvalidArgument, "key обязателен")
	}

	startedAt := time.Now()
	v, err := s.svc.Evaluate(ctx, req.GetKey(), req.GetEntityId())
	if err != nil {
		s.metrics.Error("evaluate")
		return nil, status.Error(codes.Internal, "хранилище флагов недоступно")
	}
	s.metrics.Evaluate(req.GetKey(), string(v.Reason), time.Since(startedAt).Seconds())

	return &pb.EvaluateResponse{
		Enabled:    v.Enabled,
		Reason:     string(v.Reason),
		Percentage: int32(v.Percentage),
	}, nil
}

// ListFlags: снимок всех флагов для кэша API и витрины админки.
func (s *Server) ListFlags(ctx context.Context, _ *pb.ListFlagsRequest) (*pb.ListFlagsResponse, error) {
	startedAt := time.Now()
	flags, err := s.svc.List(ctx)
	if err != nil {
		s.metrics.Error("list")
		return nil, status.Error(codes.Internal, "хранилище флагов недоступно")
	}
	s.metrics.List(time.Since(startedAt).Seconds())

	out := make([]*pb.FlagState, 0, len(flags))
	for _, f := range flags {
		out = append(out, toPb(f))
	}
	return &pb.ListFlagsResponse{Flags: out}, nil
}

// UpsertFlag: создать/обновить. Некорректный ключ или процент —
// InvalidArgument (ошибка конфигурации вызывающего, не Internal);
// сбой хранилища — Internal.
func (s *Server) UpsertFlag(ctx context.Context, req *pb.UpsertFlagRequest) (*pb.FlagState, error) {
	startedAt := time.Now()
	f, err := s.svc.Upsert(ctx, domain.Flag{
		Key:         req.GetKey(),
		Description: req.GetDescription(),
		Enabled:     req.GetEnabled(),
		Percentage:  int(req.GetPercentage()),
		Killed:      req.GetKilled(),
		UpdatedBy:   req.GetUpdatedBy(),
	})
	if err != nil {
		if errors.Is(err, service.ErrInvalidKey) || errors.Is(err, service.ErrInvalidPercent) {
			return nil, status.Error(codes.InvalidArgument, err.Error())
		}
		s.metrics.Error("upsert")
		return nil, status.Error(codes.Internal, "хранилище флагов недоступно")
	}
	s.metrics.Upsert(time.Since(startedAt).Seconds())
	return toPb(f), nil
}

// DeleteFlag: убрать флаг; deleted=false — его и не было.
func (s *Server) DeleteFlag(ctx context.Context, req *pb.DeleteFlagRequest) (*pb.DeleteFlagResponse, error) {
	if req.GetKey() == "" {
		return nil, status.Error(codes.InvalidArgument, "key обязателен")
	}
	startedAt := time.Now()
	deleted, err := s.svc.Delete(ctx, req.GetKey())
	if err != nil {
		s.metrics.Error("delete")
		return nil, status.Error(codes.Internal, "хранилище флагов недоступно")
	}
	s.metrics.Delete(time.Since(startedAt).Seconds())
	return &pb.DeleteFlagResponse{Deleted: deleted}, nil
}

func toPb(f domain.Flag) *pb.FlagState {
	return &pb.FlagState{
		Key:         f.Key,
		Description: f.Description,
		Enabled:     f.Enabled,
		Percentage:  int32(f.Percentage),
		Killed:      f.Killed,
		UpdatedBy:   f.UpdatedBy,
		UpdatedAt:   f.UpdatedAt.Format(time.RFC3339),
	}
}
