// Package grpcapi — входящий адаптер: gRPC-сервер напоминаний.
// API звонит сюда при подтверждении брони (Schedule) и возврате
// билетов (Cancel).
package grpcapi

import (
	"context"
	"errors"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"reminder-service/internal/domain"
	pb "reminder-service/internal/pb"
	"reminder-service/internal/service"
)

// Server реализует сгенерированный интерфейс; Unimplemented даёт фору
// будущим методам контракта.
type Server struct {
	pb.UnimplementedRemindersServer
	svc *service.Scheduler
}

func New(svc *service.Scheduler) *Server {
	return &Server{svc: svc}
}

// Schedule: бронь → запланированное письмо. Отказы, нормальные
// для вызывающего (мусор в запросе, прошедший сеанс) — InvalidArgument;
// сбой хранилища — Internal.
func (s *Server) Schedule(ctx context.Context, req *pb.ScheduleRequest) (*pb.ScheduleResponse, error) {
	sessionAt, err := parseSessionAt(req.GetSessionAt())
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, err.Error())
	}
	res, err := s.svc.Schedule(ctx, domain.Reminder{
		BookingID:  req.GetBookingId(),
		UserID:     req.GetUserId(),
		Email:      req.GetEmail(),
		MovieID:    req.GetMovieId(),
		MovieTitle: req.GetMovieTitle(),
		Hall:       req.GetHall(),
		SessionAt:  sessionAt,
		Seats:      req.GetSeats(),
	})
	if err != nil {
		if errors.Is(err, domain.ErrInvalidReminder) || errors.Is(err, domain.ErrSessionPassed) {
			return nil, status.Error(codes.InvalidArgument, err.Error())
		}
		return nil, status.Error(codes.Internal, "хранилище напоминаний недоступно")
	}
	return &pb.ScheduleResponse{Status: res.Status, DueAt: res.DueAt.Format(time.RFC3339)}, nil
}

// Cancel: возврат билетов гасит напоминание; MISSING — идемпотентный
// ответ, а не ошибка.
func (s *Server) Cancel(ctx context.Context, req *pb.CancelRequest) (*pb.CancelResponse, error) {
	st, err := s.svc.Cancel(ctx, req.GetBookingId())
	if err != nil {
		if errors.Is(err, domain.ErrEmptyBookingID) {
			return nil, status.Error(codes.InvalidArgument, "bookingId обязателен")
		}
		return nil, status.Error(codes.Internal, "хранилище напоминаний недоступно")
	}
	return &pb.CancelResponse{Status: st}, nil
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
