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

	"recommendation-service/internal/adapter/out/memory"
	"recommendation-service/internal/domain"
	pb "recommendation-service/internal/pb"
	"recommendation-service/internal/service"
)

// start поднимает сервер на bufconn-листенере и клиента к нему.
// Отдаём и advisor: тесты сеют сигналы через use-case, как настоящий
// консьюмер, — и проверяют сквозной путь «сигнал → профиль → топ».
func start(t *testing.T) (pb.RecommendationsClient, *service.Advisor) {
	t.Helper()
	advisor := service.NewAdvisor(memory.NewStore())

	lis := bufconn.Listen(1 << 20)
	srv := grpc.NewServer()
	pb.RegisterRecommendationsServer(srv, New(advisor))
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
	return pb.NewRecommendationsClient(conn), advisor
}

func afisha() []*pb.MovieCandidate {
	return []*pb.MovieCandidate{
		{MovieId: "m1", Title: "Дюна", Genre: "фантастика", RatingAvg: 3.0, RatingCount: 3},
		{MovieId: "m2", Title: "Осенний вальс", Genre: "драма", RatingAvg: 4.9, RatingCount: 40},
		{MovieId: "m3", Title: "Скрик", Genre: "хоррор"},
		{MovieId: "m4", Title: "Марсианин", Genre: "фантастика", RatingAvg: 4.0, RatingCount: 9},
	}
}

func TestGetRecommendationsColdStart(t *testing.T) {
	client, _ := start(t)
	resp, err := client.GetRecommendations(context.Background(), &pb.RecommendationsRequest{
		UserId: "u-new", Candidates: afisha(),
	})
	if err != nil {
		t.Fatal(err)
	}
	if resp.GetBasis() != "popular" {
		t.Fatalf("Basis = %q, want popular", resp.GetBasis())
	}
	if len(resp.GetItems()) != 4 {
		t.Fatalf("топ = %d, want 4 (дефолт)", len(resp.GetItems()))
	}
	if resp.GetItems()[0].GetMovieId() != "m2" {
		t.Fatalf("первый = %s, want m2 (рейтинг 4.9)", resp.GetItems()[0].GetMovieId())
	}
}

func TestGetRecommendationsByProfile(t *testing.T) {
	client, advisor := start(t)
	// зритель смотрел «Дюну» (фантастика) и высоко оценил её отзывом
	for _, s := range []domain.Signal{
		{UserID: "u1", MovieID: "m1", MovieTitle: "Дюна", Genre: "фантастика", Kind: domain.KindBooking, DedupKey: "booking:b1"},
		{UserID: "u1", MovieID: "m1", MovieTitle: "Дюна", Genre: "фантастика", Kind: domain.KindReview, Rating: 5, DedupKey: "review:r1"},
	} {
		if err := advisor.HandleSignal(context.Background(), s); err != nil {
			t.Fatal(err)
		}
	}

	resp, err := client.GetRecommendations(context.Background(), &pb.RecommendationsRequest{
		UserId: "u1", Candidates: afisha(),
	})
	if err != nil {
		t.Fatal(err)
	}
	if resp.GetBasis() != "profile" {
		t.Fatalf("Basis = %q, want profile", resp.GetBasis())
	}
	items := resp.GetItems()
	if len(items) != 3 { // m1 просмотрен и исключён
		t.Fatalf("топ = %d, want 3", len(items))
	}
	if items[0].GetMovieId() != "m4" {
		t.Fatalf("первый = %s, want m4 (фантастика по профилю)", items[0].GetMovieId())
	}
	if items[0].GetReason() != "вы часто смотрите «фантастика»" {
		t.Fatalf("Reason = %q", items[0].GetReason())
	}
}

func TestGetRecommendationsEmptyUser(t *testing.T) {
	client, _ := start(t)
	_, err := client.GetRecommendations(context.Background(), &pb.RecommendationsRequest{Candidates: afisha()})
	if status.Code(err) != codes.InvalidArgument {
		t.Fatalf("код = %v, want InvalidArgument", status.Code(err))
	}
}

func TestGetRecommendationsLimit(t *testing.T) {
	client, _ := start(t)
	resp, err := client.GetRecommendations(context.Background(), &pb.RecommendationsRequest{
		UserId: "u-new", Candidates: afisha(), Limit: 2,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(resp.GetItems()) != 2 {
		t.Fatalf("топ с limit=2 = %d, want 2", len(resp.GetItems()))
	}
}
