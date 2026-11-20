package grpcapi

import (
	"context"
	"net"
	"testing"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"
	"google.golang.org/grpc/test/bufconn"

	"detective-service/internal/adapter/out/memory"
	"detective-service/internal/adapter/out/prom"
	"detective-service/internal/domain"
	pb "detective-service/internal/pb"
	"detective-service/internal/service"
)

// start поднимает сервер на bufconn-листенере и клиента к нему:
// сквозной путь Score/Resolve без сети, поверх памяти-стора.
func start(t *testing.T) pb.DetectiveClient {
	t.Helper()
	svc := service.NewDetective(memory.NewStore(), domain.Thresholds{Review: 40, Block: 70})
	metrics := prom.New()

	lis := bufconn.Listen(1 << 20)
	srv := grpc.NewServer()
	pb.RegisterDetectiveServer(srv, New(svc, metrics))
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
	return pb.NewDetectiveClient(conn)
}

func calm() *pb.ScoreRequest {
	return &pb.ScoreRequest{
		BookingId: "b-calm", UserId: "u-1", SessionId: "s-1",
		SeatsCount: 2, TotalRub: 800, AccountAgeDays: 30,
	}
}

func suspicious() *pb.ScoreRequest {
	return &pb.ScoreRequest{
		BookingId: "b-fast", UserId: "u-2", SessionId: "s-1",
		SeatsCount: 2, TotalRub: 800,
		AccountAgeDays: 0, Bookings24H: 5,
	}
}

func TestScoreVerdicts(t *testing.T) {
	client := start(t)
	ctx := context.Background()

	calmRes, err := client.Score(ctx, calm())
	if err != nil {
		t.Fatal(err)
	}
	if calmRes.GetVerdict() != "allow" || calmRes.GetScore() != 0 {
		t.Fatalf("спокойная бронь: %+v", calmRes)
	}

	fastRes, err := client.Score(ctx, suspicious())
	if err != nil {
		t.Fatal(err)
	}
	if fastRes.GetVerdict() != "review" || fastRes.GetScore() != 55 {
		t.Fatalf("подозрительная бронь: %+v", fastRes)
	}
	if len(fastRes.GetReasons()) != 2 || fastRes.GetReasons()[0] != "newAccount" {
		t.Fatalf("причины: %v", fastRes.GetReasons())
	}
}

// повторный Score той же брони возвращает первый вердикт — независимо
// от того, как «уточнились» факты
func TestScoreIdempotentOverGrpc(t *testing.T) {
	client := start(t)
	ctx := context.Background()

	if _, err := client.Score(ctx, suspicious()); err != nil {
		t.Fatal(err)
	}
	worse := suspicious()
	worse.Bookings24H = 20
	worse.SeatsCount = 6
	res, err := client.Score(ctx, worse)
	if err != nil {
		t.Fatal(err)
	}
	if res.GetVerdict() != "review" || res.GetScore() != 55 {
		t.Fatalf("вердикт пересмотрен задним числом: %+v", res)
	}
}

func TestScoreValidation(t *testing.T) {
	client := start(t)
	ctx := context.Background()

	noBooking := calm()
	noBooking.BookingId = ""
	if _, err := client.Score(ctx, noBooking); status.Code(err) != codes.InvalidArgument {
		t.Fatalf("без booking_id: %v", err)
	}
	noUser := calm()
	noUser.UserId = ""
	if _, err := client.Score(ctx, noUser); status.Code(err) != codes.InvalidArgument {
		t.Fatalf("без user_id: %v", err)
	}
}

func TestResolveCodes(t *testing.T) {
	client := start(t)
	ctx := context.Background()

	// решение не найдено — NotFound
	if _, err := client.Resolve(ctx, &pb.ResolveRequest{
		BookingId: "нет-такой", Action: "approve", ResolvedBy: "admin@test.local",
	}); status.Code(err) != codes.NotFound {
		t.Fatalf("чужая бронь: %v", err)
	}

	// мусорное действие — InvalidArgument
	if _, err := client.Resolve(ctx, &pb.ResolveRequest{
		BookingId: "b-calm", Action: "подумать", ResolvedBy: "admin@test.local",
	}); status.Code(err) != codes.InvalidArgument {
		t.Fatalf("мусорное действие: %v", err)
	}

	// review-решение резолвится, повтор — FailedPrecondition
	if _, err := client.Score(ctx, suspicious()); err != nil {
		t.Fatal(err)
	}
	res, err := client.Resolve(ctx, &pb.ResolveRequest{
		BookingId: "b-fast", Action: "approve", ResolvedBy: "admin@test.local",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !res.GetResolved() || res.GetStatus() != "approved" {
		t.Fatalf("резолв: %+v", res)
	}
	if _, err := client.Resolve(ctx, &pb.ResolveRequest{
		BookingId: "b-fast", Action: "reject", ResolvedBy: "admin2@test.local",
	}); status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("повторный резолв: %v", err)
	}

	// авто-allow закрыт сразу — резолвить нельзя (уже решено)
	if _, err := client.Score(ctx, calm()); err != nil {
		t.Fatal(err)
	}
	if _, err := client.Resolve(ctx, &pb.ResolveRequest{
		BookingId: "b-calm", Action: "approve", ResolvedBy: "admin@test.local",
	}); status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("резолв авто-вердикта: %v", err)
	}
}

// пустой resolved_by — InvalidArgument: аудит без имени решающего
// не имеет смысла
func TestResolveRequiresResolvedBy(t *testing.T) {
	client := start(t)
	ctx := context.Background()
	if _, err := client.Resolve(ctx, &pb.ResolveRequest{
		BookingId: "b-fast", Action: "approve",
	}); status.Code(err) != codes.InvalidArgument {
		t.Fatalf("без resolved_by: %v", err)
	}
}
