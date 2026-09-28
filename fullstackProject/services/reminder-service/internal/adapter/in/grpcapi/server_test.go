package grpcapi

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"
	"google.golang.org/grpc/test/bufconn"

	"reminder-service/internal/adapter/out/memory"
	"reminder-service/internal/adapter/out/prom"
	"reminder-service/internal/domain"
	pb "reminder-service/internal/pb"
	"reminder-service/internal/service"
)

// start поднимает сервер на bufconn-листенере и клиента к нему.
// Публикатор настоящий не нужен: тесты проверяют планирование,
// тик в них не участвует.
func start(t *testing.T) (pb.RemindersClient, *service.Scheduler, *prom.Metrics) {
	t.Helper()
	scheduler := service.NewScheduler(memory.NewStore(), nopPublisher{}, 2*time.Hour)
	metrics := prom.New()

	lis := bufconn.Listen(1 << 20)
	srv := grpc.NewServer()
	pb.RegisterRemindersServer(srv, New(scheduler, metrics))
	go func() { _ = srv.Serve(lis) }()
	t.Cleanup(srv.Stop)

	conn, err := grpc.NewClient("passthrough:///bufnet",
		grpc.WithContextDialer(func(ctx context.Context, _ string) (net.Conn, error) {
			return lis.DialContext(ctx)
		}),
		grpc.WithTransportCredentials(insecure.NewCredentials()),
	)
	if err != nil {
		t.Fatalf("клиент bufconn: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	return pb.NewRemindersClient(conn), scheduler, metrics
}

// nopPublisher — заглушка порта доставки: gRPC-тесты не тикают.
type nopPublisher struct{}

func (nopPublisher) Publish(context.Context, domain.Reminder) error { return nil }

func futureRequest() *pb.ScheduleRequest {
	return &pb.ScheduleRequest{
		BookingId: "b-1", UserId: "u-1", Email: "u@cine.local",
		MovieId: "m-1", MovieTitle: "Дюна", Hall: "Красный",
		SessionAt: time.Now().Add(5 * time.Hour).Format(time.RFC3339),
		Seats:     []string{"5-7", "5-8"},
	}
}

func TestScheduleOk(t *testing.T) {
	client, _, _ := start(t)
	resp, err := client.Schedule(context.Background(), futureRequest())
	if err != nil {
		t.Fatal(err)
	}
	if resp.GetStatus() != "SCHEDULED" {
		t.Fatalf("status = %q, want SCHEDULED", resp.GetStatus())
	}
	if due, err := time.Parse(time.RFC3339, resp.GetDueAt()); err != nil || due.IsZero() {
		t.Fatalf("dueAt = %q (%v), want RFC3339-момент", resp.GetDueAt(), err)
	}
}

func TestSchedulePastSession(t *testing.T) {
	client, _, _ := start(t)
	req := futureRequest()
	req.SessionAt = time.Now().Add(-time.Hour).Format(time.RFC3339)
	if _, err := client.Schedule(context.Background(), req); status.Code(err) != codes.InvalidArgument {
		t.Fatalf("код = %v, want InvalidArgument", status.Code(err))
	}
}

func TestScheduleGarbageSessionAt(t *testing.T) {
	client, _, _ := start(t)
	req := futureRequest()
	req.SessionAt = "завтра"
	if _, err := client.Schedule(context.Background(), req); status.Code(err) != codes.InvalidArgument {
		t.Fatalf("код = %v, want InvalidArgument", status.Code(err))
	}
}

func TestScheduleInvalidFields(t *testing.T) {
	client, _, _ := start(t)
	req := futureRequest()
	req.Email = ""
	if _, err := client.Schedule(context.Background(), req); status.Code(err) != codes.InvalidArgument {
		t.Fatalf("код = %v, want InvalidArgument", status.Code(err))
	}
}

func TestCancelMissingIsNotError(t *testing.T) {
	client, _, _ := start(t)
	resp, err := client.Cancel(context.Background(), &pb.CancelRequest{BookingId: "b-нет"})
	if err != nil {
		t.Fatal(err)
	}
	if resp.GetStatus() != "MISSING" {
		t.Fatalf("status = %q, want MISSING", resp.GetStatus())
	}
}

func TestCancelAfterSchedule(t *testing.T) {
	client, _, _ := start(t)
	ctx := context.Background()
	if _, err := client.Schedule(ctx, futureRequest()); err != nil {
		t.Fatal(err)
	}
	resp, err := client.Cancel(ctx, &pb.CancelRequest{BookingId: "b-1"})
	if err != nil {
		t.Fatal(err)
	}
	if resp.GetStatus() != "CANCELLED" {
		t.Fatalf("status = %q, want CANCELLED", resp.GetStatus())
	}
}

func TestCancelEmptyBookingID(t *testing.T) {
	client, _, _ := start(t)
	if _, err := client.Cancel(context.Background(), &pb.CancelRequest{}); status.Code(err) != codes.InvalidArgument {
		t.Fatalf("код = %v, want InvalidArgument", status.Code(err))
	}
}

// вердикты Schedule/Cancel обязаны отражаться в выгрузке Prometheus
func TestScheduleCancelMetricsMirror(t *testing.T) {
	client, _, metrics := start(t)
	ctx := context.Background()

	if _, err := client.Schedule(ctx, futureRequest()); err != nil {
		t.Fatal(err)
	}
	if _, err := client.Cancel(ctx, &pb.CancelRequest{BookingId: "b-1"}); err != nil {
		t.Fatal(err)
	}
	// повторная отмена — идемпотентный MISSING
	if _, err := client.Cancel(ctx, &pb.CancelRequest{BookingId: "b-1"}); err != nil {
		t.Fatal(err)
	}

	rec := httptest.NewRecorder()
	metrics.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	body := rec.Body.String()
	for _, want := range []string{
		`cine_reminder_scheduled_total{result="ok"} 1`,
		`cine_reminder_cancels_total{status="cancelled"} 1`,
		`cine_reminder_cancels_total{status="missing"} 1`,
	} {
		if !strings.Contains(body, want) {
			t.Errorf("в выгрузке нет строки %q", want)
		}
	}
}
