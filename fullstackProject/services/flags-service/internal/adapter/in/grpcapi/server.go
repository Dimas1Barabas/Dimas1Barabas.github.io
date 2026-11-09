// Package grpcapi — входящий адаптер: gRPC-сервер «Суфлёра».
// Гварды NestJS API спрашивают вердикты (Evaluate), кэш состояний
// берёт снимок (ListFlags), админка правит (UpsertFlag/DeleteFlag),
// точки применения фичи отчитывают метрики (ReportExposure/
// ReportConversion).
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
		Variant:    v.Variant,
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

// UpsertFlag: создать/обновить. Некорректный ключ, процент или варианты —
// InvalidArgument (ошибка конфигурации вызывающего, не Internal);
// сбой хранилища — Internal.
func (s *Server) UpsertFlag(ctx context.Context, req *pb.UpsertFlagRequest) (*pb.FlagState, error) {
	startedAt := time.Now()
	variants := make([]domain.Variant, 0, len(req.GetVariants()))
	for _, v := range req.GetVariants() {
		variants = append(variants, domain.Variant{Name: v.GetName(), Percentage: int(v.GetPercentage())})
	}
	f, err := s.svc.Upsert(ctx, domain.Flag{
		Key:         req.GetKey(),
		Description: req.GetDescription(),
		Enabled:     req.GetEnabled(),
		Percentage:  int(req.GetPercentage()),
		Killed:      req.GetKilled(),
		Variants:    variants,
		UpdatedBy:   req.GetUpdatedBy(),
	})
	if err != nil {
		if errors.Is(err, service.ErrInvalidKey) ||
			errors.Is(err, service.ErrInvalidPercent) ||
			errors.Is(err, service.ErrInvalidVariants) {
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

// ReportExposure: засчитать показ точки применения. Вариант не присылают —
// сервис пересчитывает его из бакетинга; not_found — counted=false, не ошибка.
func (s *Server) ReportExposure(ctx context.Context, req *pb.ReportRequest) (*pb.ReportResponse, error) {
	return s.report(ctx, req, "exposure", s.svc.ReportExposure)
}

// ReportConversion: засчитать конверсию — та же семантика, что у экспозиции.
func (s *Server) ReportConversion(ctx context.Context, req *pb.ReportRequest) (*pb.ReportResponse, error) {
	return s.report(ctx, req, "conversion", s.svc.ReportConversion)
}

func (s *Server) report(
	ctx context.Context,
	req *pb.ReportRequest,
	kind string,
	call func(context.Context, string, string) (string, bool, error),
) (*pb.ReportResponse, error) {
	if req.GetKey() == "" {
		return nil, status.Error(codes.InvalidArgument, "key обязателен")
	}
	startedAt := time.Now()
	variant, counted, err := call(ctx, req.GetKey(), req.GetEntityId())
	if err != nil {
		s.metrics.Error("report")
		return nil, status.Error(codes.Internal, "хранилище флагов недоступно")
	}
	s.metrics.Report(kind, time.Since(startedAt).Seconds())
	return &pb.ReportResponse{Variant: variant, Counted: counted}, nil
}

func toPb(f domain.Flag) *pb.FlagState {
	variants := make([]*pb.Variant, 0, len(f.Variants))
	for _, v := range f.Variants {
		variants = append(variants, &pb.Variant{Name: v.Name, Percentage: int32(v.Percentage)})
	}
	return &pb.FlagState{
		Key:         f.Key,
		Description: f.Description,
		Enabled:     f.Enabled,
		Percentage:  int32(f.Percentage),
		Killed:      f.Killed,
		Variants:    variants,
		UpdatedBy:   f.UpdatedBy,
		UpdatedAt:   f.UpdatedAt.Format(time.RFC3339),
	}
}
