// Package grpcapi — входящий адаптер: gRPC-сервер рекомендаций.
// Основной интерфейс КиноСоветника: кандидатов афиши присылает вызывающий
// (NestJS API), сервис отвечает топом со скорами и причинами.
package grpcapi

import (
	"context"
	"errors"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"recommendation-service/internal/domain"
	pb "recommendation-service/internal/pb"
	"recommendation-service/internal/service"
)

// Server реализует сгенерированный интерфейс; Unimplemented даёт фору
// будущим методам контракта.
type Server struct {
	pb.UnimplementedRecommendationsServer
	svc *service.Advisor
}

func New(svc *service.Advisor) *Server {
	return &Server{svc: svc}
}

// GetRecommendations: userId → топ афиши. Доменные ошибки переводятся
// в gRPC-коды: невалидный запрос — InvalidArgument, сбой хранилища — Internal.
func (s *Server) GetRecommendations(ctx context.Context, req *pb.RecommendationsRequest) (*pb.RecommendationsResponse, error) {
	candidates := make([]domain.Movie, 0, len(req.GetCandidates()))
	for _, c := range req.GetCandidates() {
		candidates = append(candidates, domain.Movie{
			MovieID:     c.GetMovieId(),
			Title:       c.GetTitle(),
			Genre:       c.GetGenre(),
			RatingAvg:   c.GetRatingAvg(),
			RatingCount: int(c.GetRatingCount()),
		})
	}

	rec, err := s.svc.Recommend(ctx, req.GetUserId(), candidates, int(req.GetLimit()))
	if err != nil {
		if errors.Is(err, domain.ErrEmptyUserID) {
			return nil, status.Error(codes.InvalidArgument, "userId обязателен")
		}
		return nil, status.Error(codes.Internal, "хранилище сигналов недоступно")
	}

	items := make([]*pb.RecommendationItem, 0, len(rec.Items))
	for _, it := range rec.Items {
		items = append(items, &pb.RecommendationItem{
			MovieId: it.MovieID,
			Title:   it.Title,
			Genre:   it.Genre,
			Score:   it.Score,
			Reason:  it.Reason,
		})
	}
	return &pb.RecommendationsResponse{Items: items, Basis: rec.Basis}, nil
}
