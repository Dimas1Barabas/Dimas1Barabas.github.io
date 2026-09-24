package httpapi

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"testing"

	"recommendation-service/internal/adapter/out/memory"
	"recommendation-service/internal/domain"
	"recommendation-service/internal/service"
)

func start(t *testing.T) (*httptest.Server, *service.Advisor) {
	t.Helper()
	advisor := service.NewAdvisor(memory.NewStore())
	ts := httptest.NewServer(New("test", advisor).Handler)
	t.Cleanup(ts.Close)
	return ts, advisor
}

func TestHealth(t *testing.T) {
	ts, _ := start(t)

	resp, err := ts.Client().Get(ts.URL + "/health")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("код /health = %d, want 200", resp.StatusCode)
	}
	var body map[string]string
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body["status"] != "ok" {
		t.Fatalf("body = %v, want status ok", body)
	}
}

func TestProfile(t *testing.T) {
	ts, advisor := start(t)
	err := advisor.HandleSignal(context.Background(), domain.Signal{
		UserID: "u1", MovieID: "m1", MovieTitle: "Дюна", Genre: "фантастика",
		Kind: domain.KindReview, Rating: 5, DedupKey: "review:r1",
	})
	if err != nil {
		t.Fatal(err)
	}

	resp, err := ts.Client().Get(ts.URL + "/profile?userId=u1")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("код /profile = %d, want 200", resp.StatusCode)
	}
	var body struct {
		UserID       string             `json:"userId"`
		GenreWeights map[string]float64 `json:"genreWeights"`
		SeenCount    int                `json:"seenCount"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body.UserID != "u1" || body.GenreWeights["фантастика"] != 1.2 || body.SeenCount != 1 {
		t.Fatalf("body = %+v, want u1/фантастика=1.2/1", body)
	}
}

func TestProfileWithoutUser(t *testing.T) {
	ts, _ := start(t)

	resp, err := ts.Client().Get(ts.URL + "/profile")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 400 {
		t.Fatalf("код /profile без userId = %d, want 400", resp.StatusCode)
	}
}
