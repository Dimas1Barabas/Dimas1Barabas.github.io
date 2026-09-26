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

	"ratelimiter-service/internal/adapter/out/memory"
	"ratelimiter-service/internal/domain"
	pb "ratelimiter-service/internal/pb"
	"ratelimiter-service/internal/service"
)

// start поднимает сервер на bufconn-листенере и клиента к нему:
// сквозной путь Check без сети, поверх памяти-стора.
func start(t *testing.T) pb.RateLimiterClient {
	t.Helper()
	policies := map[domain.Action]domain.Policy{
		domain.ActionBookingsCreate: domain.PolicyOf(10),
		domain.ActionAuthLogin:      domain.PolicyOf(5),
	}
	limiter := service.NewLimiter(memory.NewStore(), policies)

	lis := bufconn.Listen(1 << 20)
	srv := grpc.NewServer()
	pb.RegisterRateLimiterServer(srv, New(limiter))
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
	return pb.NewRateLimiterClient(conn)
}

func checkRequest() *pb.CheckRateRequest {
	return &pb.CheckRateRequest{Action: "bookings.create", Key: "user-1"}
}

func TestCheckBurstThenRefused(t *testing.T) {
	client := start(t)
	ctx := context.Background()

	for i := 0; i < 10; i++ {
		resp, err := client.Check(ctx, checkRequest())
		if err != nil {
			t.Fatal(err)
		}
		if !resp.GetAllowed() {
			t.Fatalf("бронь %d должна проходить (burst 10)", i+1)
		}
		if resp.GetLimit() != 10 || resp.GetCapacity() != 10 {
			t.Fatalf("политика в ответе = %+v", resp)
		}
	}

	resp, err := client.Check(ctx, checkRequest())
	if err != nil {
		t.Fatal(err)
	}
	if resp.GetAllowed() {
		t.Fatalf("11-я подряд бронь — отказ")
	}
	// долив 10/60 в сек → целый токен через ~6 c
	if resp.GetRetryAfterMs() < 5000 || resp.GetRetryAfterMs() > 7000 {
		t.Fatalf("retryAfterMs = %d, ожидали ~6000", resp.GetRetryAfterMs())
	}
	if resp.GetRemaining() != 0 {
		t.Fatalf("целых токенов после отказа = %d, ожидали 0", resp.GetRemaining())
	}
}

func TestCheckSeparateBuckets(t *testing.T) {
	client := start(t)
	ctx := context.Background()

	// выжигаем корзину входа конкретного ящика
	for i := 0; i < 5; i++ {
		resp, err := client.Check(ctx, &pb.CheckRateRequest{Action: "auth.login", Key: "bot@test.local"})
		if err != nil || !resp.GetAllowed() {
			t.Fatalf("вход %d: %v / allowed=%v", i+1, err, resp.GetAllowed())
		}
	}
	if resp, _ := client.Check(ctx, &pb.CheckRateRequest{Action: "auth.login", Key: "bot@test.local"}); resp.GetAllowed() {
		t.Fatalf("6-я попытка входа — отказ")
	}
	// другой ящик и бронь — свои корзины
	if resp, err := client.Check(ctx, &pb.CheckRateRequest{Action: "auth.login", Key: "human@test.local"}); err != nil || !resp.GetAllowed() {
		t.Fatalf("чужая корзина входа не должна пострадать: %v", err)
	}
	if resp, err := client.Check(ctx, checkRequest()); err != nil || !resp.GetAllowed() {
		t.Fatalf("у действия своя корзина: %v", err)
	}
}

func TestCheckValidation(t *testing.T) {
	client := start(t)
	for _, tc := range []struct {
		name string
		mut  func(*pb.CheckRateRequest)
	}{
		{"нет действия", func(r *pb.CheckRateRequest) { r.Action = "" }},
		{"нет ключа", func(r *pb.CheckRateRequest) { r.Key = "" }},
		{"мусорное действие", func(r *pb.CheckRateRequest) { r.Action = "reviews.create" }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := checkRequest()
			tc.mut(req)
			if _, err := client.Check(context.Background(), req); status.Code(err) != codes.InvalidArgument {
				t.Fatalf("код = %v, want InvalidArgument", status.Code(err))
			}
		})
	}
}
