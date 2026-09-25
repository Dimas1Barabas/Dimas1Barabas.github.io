package grpcapi

import (
	"context"
	"net"
	"testing"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"
	"google.golang.org/grpc/test/bufconn"

	"fmt"
	"pricing-service/internal/adapter/out/memory"
	pb "pricing-service/internal/pb"
	"pricing-service/internal/service"
)

// start поднимает сервер на bufconn-листенере и клиента к нему.
// Спрос в тестах гоняется через те же use-case'ы, что и консьюмер:
// held/released → Quote, сквозной путь без брокера.
func start(t *testing.T) (pb.PricingClient, *service.Pricer) {
	t.Helper()
	pricer := service.NewPricer(memory.NewStore())

	lis := bufconn.Listen(1 << 20)
	srv := grpc.NewServer()
	pb.RegisterPricingServer(srv, New(pricer))
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
	return pb.NewPricingClient(conn), pricer
}

func quoteRequest() *pb.QuoteRequest {
	return &pb.QuoteRequest{
		SessionId:    "s-1",
		SessionAt:    time.Date(2026, time.September, 22, 19, 0, 0, 0, time.Local).Format(time.RFC3339),
		BasePriceRub: 400,
		Capacity:     80,
	}
}

func TestQuoteOk(t *testing.T) {
	client, _ := start(t)
	resp, err := client.Quote(context.Background(), quoteRequest())
	if err != nil {
		t.Fatal(err)
	}
	// вечер буднего (событий спроса не было — зал пуст): 400 × 1.2 × 0.9 = 430
	if resp.GetPriceRub() != 430 {
		t.Fatalf("price = %d, want 430", resp.GetPriceRub())
	}
	if resp.GetBasePriceRub() != 400 || resp.GetOccupied() != 0 || resp.GetCapacity() != 80 {
		t.Fatalf("ответ некорректен: %+v", resp)
	}
	if len(resp.GetFactors()) != 2 { // evening + demand_low
		t.Fatalf("факторы = %+v, want 2 шт", resp.GetFactors())
	}
	if resp.GetFactors()[0].GetCode() != "evening" || resp.GetFactors()[0].GetPercent() != 20 {
		t.Fatalf("первый фактор = %+v, want evening+20", resp.GetFactors()[0])
	}
}

func TestQuoteEndToEndDemand(t *testing.T) {
	client, pricer := start(t)
	ctx := context.Background()
	// десять броней по 7 мест — 70/80 (87%), аншлаг поверх вечера
	for i := 0; i < 10; i++ {
		if err := pricer.HandleHeld(ctx, "s-1", "b-held-"+fmt.Sprintf("%d", i), 7); err != nil {
			t.Fatal(err)
		}
	}
	resp, err := client.Quote(ctx, quoteRequest())
	if err != nil {
		t.Fatal(err)
	}
	// 400 × 1.2 (вечер) × 1.25 (аншлаг) = 600
	if resp.GetPriceRub() != 600 {
		t.Fatalf("price = %d, want 600", resp.GetPriceRub())
	}
	if resp.GetOccupied() != 70 {
		t.Fatalf("occupied = %d, want 70", resp.GetOccupied())
	}
	// девять броней вернули места (63) — осталось 7/80 (9%), аншлаг
	// погашен, зал почти пуст: 400 × 1.2 × 0.9 = 430
	for i := 0; i < 9; i++ {
		if err := pricer.HandleReleased(ctx, "s-1", "b-held-"+fmt.Sprintf("%d", i), 7); err != nil {
			t.Fatal(err)
		}
	}
	resp, err = client.Quote(ctx, quoteRequest())
	if err != nil {
		t.Fatal(err)
	}
	if resp.GetPriceRub() != 430 {
		t.Fatalf("price = %d, want 430", resp.GetPriceRub())
	}
	if resp.GetOccupied() != 7 {
		t.Fatalf("occupied = %d, want 7", resp.GetOccupied())
	}
}

func TestQuoteGarbageSessionAt(t *testing.T) {
	client, _ := start(t)
	req := quoteRequest()
	req.SessionAt = "завтра"
	if _, err := client.Quote(context.Background(), req); status.Code(err) != codes.InvalidArgument {
		t.Fatalf("код = %v, want InvalidArgument", status.Code(err))
	}
	req.SessionAt = ""
	if _, err := client.Quote(context.Background(), req); status.Code(err) != codes.InvalidArgument {
		t.Fatalf("код = %v, want InvalidArgument", status.Code(err))
	}
}

func TestQuoteValidation(t *testing.T) {
	client, _ := start(t)
	for _, tc := range []struct {
		name string
		mut  func(*pb.QuoteRequest)
	}{
		{"нет сеанса", func(r *pb.QuoteRequest) { r.SessionId = "" }},
		{"база нулевая", func(r *pb.QuoteRequest) { r.BasePriceRub = 0 }},
		{"ёмкость нулевая", func(r *pb.QuoteRequest) { r.Capacity = 0 }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := quoteRequest()
			tc.mut(req)
			if _, err := client.Quote(context.Background(), req); status.Code(err) != codes.InvalidArgument {
				t.Fatalf("код = %v, want InvalidArgument", status.Code(err))
			}
		})
	}
}
