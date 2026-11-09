package grpcapi

import (
	"context"
	"testing"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"flags-service/internal/adapter/out/memory"
	"flags-service/internal/adapter/out/prom"
	pb "flags-service/internal/pb"
	"flags-service/internal/service"
)

func newServer() *Server {
	store := memory.NewStore()
	return New(service.New(store, store), prom.New())
}

func codeOf(t *testing.T, err error) codes.Code {
	t.Helper()
	if err == nil {
		t.Fatalf("ожидали ошибку RPC")
	}
	s, ok := status.FromError(err)
	if !ok {
		t.Fatalf("не gRPC-ошибка: %v", err)
	}
	return s.Code()
}

func TestEvaluateFlow(t *testing.T) {
	srv := newServer()
	ctx := context.Background()

	// флага нет — штатный вердикт, не ошибка RPC
	v, err := srv.Evaluate(ctx, &pb.EvaluateRequest{Key: "ghost.flag", EntityId: "user-1"})
	if err != nil {
		t.Fatalf("not_found — не ошибка: %v", err)
	}
	if v.Enabled || v.Reason != "not_found" {
		t.Fatalf("ожид not_found/off: %+v", v)
	}

	// создаём частичную раскатку 15%: user-2 (бакет 10) внутри, user-1 (99) снаружи
	if _, err := srv.UpsertFlag(ctx, &pb.UpsertFlagRequest{
		Key: "checkout.new_flow", Description: "новый чекаут",
		Enabled: true, Percentage: 15, UpdatedBy: "qa",
	}); err != nil {
		t.Fatal(err)
	}
	v, err = srv.Evaluate(ctx, &pb.EvaluateRequest{Key: "checkout.new_flow", EntityId: "user-2"})
	if err != nil || !v.Enabled || v.Reason != "percentage" || v.Percentage != 15 {
		t.Fatalf("user-2 внутри 15%%: %+v / %v", v, err)
	}
	if v, err := srv.Evaluate(ctx, &pb.EvaluateRequest{Key: "checkout.new_flow", EntityId: "user-1"}); err != nil || v.Enabled {
		t.Fatalf("user-1 снаружи: %+v / %v", v, err)
	}

	// kill-switch поверх всего
	if _, err := srv.UpsertFlag(ctx, &pb.UpsertFlagRequest{
		Key: "checkout.new_flow", Enabled: true, Percentage: 100, Killed: true, UpdatedBy: "admin",
	}); err != nil {
		t.Fatal(err)
	}
	if v, _ := srv.Evaluate(ctx, &pb.EvaluateRequest{Key: "checkout.new_flow", EntityId: "user-2"}); v.Enabled || v.Reason != "kill_switch" {
		t.Fatalf("kill-switch оффит даже 100%%: %+v", v)
	}
}

func TestEvaluateEmptyKeyIsInvalidArgument(t *testing.T) {
	srv := newServer()
	if _, err := srv.Evaluate(context.Background(), &pb.EvaluateRequest{EntityId: "user-1"}); codeOf(t, err) != codes.InvalidArgument {
		t.Fatalf("пустой key — InvalidArgument: %v", err)
	}
}

func TestUpsertInvalidKeyAndPercent(t *testing.T) {
	srv := newServer()
	ctx := context.Background()

	if _, err := srv.UpsertFlag(ctx, &pb.UpsertFlagRequest{Key: "BAD KEY", Percentage: 50}); codeOf(t, err) != codes.InvalidArgument {
		t.Fatalf("мусорный ключ — InvalidArgument: %v", err)
	}
	if _, err := srv.UpsertFlag(ctx, &pb.UpsertFlagRequest{Key: "ok.flag", Percentage: 101}); codeOf(t, err) != codes.InvalidArgument {
		t.Fatalf("процент вне 0..100 — InvalidArgument: %v", err)
	}
}

func TestListAndDelete(t *testing.T) {
	srv := newServer()
	ctx := context.Background()

	if _, err := srv.UpsertFlag(ctx, &pb.UpsertFlagRequest{Key: "a.flag", Description: "A", Percentage: 1}); err != nil {
		t.Fatal(err)
	}
	if _, err := srv.UpsertFlag(ctx, &pb.UpsertFlagRequest{Key: "b.flag", Description: "B", Percentage: 2}); err != nil {
		t.Fatal(err)
	}
	list, err := srv.ListFlags(ctx, &pb.ListFlagsRequest{})
	if err != nil || len(list.Flags) != 2 {
		t.Fatalf("снимок из двух флагов: %d / %v", len(list.Flags), err)
	}
	if list.Flags[0].Key != "a.flag" || list.Flags[0].UpdatedAt == "" {
		t.Fatalf("маппинг FlagState: %+v", list.Flags[0])
	}

	d, err := srv.DeleteFlag(ctx, &pb.DeleteFlagRequest{Key: "a.flag"})
	if err != nil || !d.Deleted {
		t.Fatalf("удаление существующего: %v / %v", d, err)
	}
	if d, _ := srv.DeleteFlag(ctx, &pb.DeleteFlagRequest{Key: "a.flag"}); d.Deleted {
		t.Fatalf("повторное удаление — deleted=false")
	}
	if _, err := srv.DeleteFlag(ctx, &pb.DeleteFlagRequest{}); codeOf(t, err) != codes.InvalidArgument {
		t.Fatalf("пустой key — InvalidArgument: %v", err)
	}
}

// пустая сущность (аноним) — тоже детерминированный вердикт:
// бакет считается от константы, не от случайности запроса
func TestEvaluateEmptyEntityIsDeterministic(t *testing.T) {
	srv := newServer()
	ctx := context.Background()
	if _, err := srv.UpsertFlag(ctx, &pb.UpsertFlagRequest{Key: "anon.flag", Enabled: true, Percentage: 100}); err != nil {
		t.Fatal(err)
	}
	first, err := srv.Evaluate(ctx, &pb.EvaluateRequest{Key: "anon.flag"})
	if err != nil {
		t.Fatal(err)
	}
	second, _ := srv.Evaluate(ctx, &pb.EvaluateRequest{Key: "anon.flag"})
	if first.GetEnabled() != second.GetEnabled() || first.GetReason() != second.GetReason() {
		t.Fatalf("пустая сущность тоже детерминирована: %+v против %+v", first, second)
	}
}

// эксперимент: Evaluate отдаёт вариант, отчёты метрик приходят тем же
// бакетингом; витрина снимка несёт конфигурацию вариантов
func TestExperimentEvaluateAndReports(t *testing.T) {
	srv := newServer()
	ctx := context.Background()

	if _, err := srv.UpsertFlag(ctx, &pb.UpsertFlagRequest{
		Key: "checkout.new_flow", Description: "A/B чекаута", Enabled: true, UpdatedBy: "qa",
		Variants: []*pb.Variant{
			{Name: "a", Percentage: 15},
			{Name: "b", Percentage: 20},
		},
	}); err != nil {
		t.Fatal(err)
	}

	// user-2 (бакет 10) — вариант a; user-1 (99) — база
	v, err := srv.Evaluate(ctx, &pb.EvaluateRequest{Key: "checkout.new_flow", EntityId: "user-2"})
	if err != nil || !v.Enabled || v.Reason != "variant" || v.Variant != "a" {
		t.Fatalf("вердикт с вариантом a: %+v / %v", v, err)
	}
	if v, _ := srv.Evaluate(ctx, &pb.EvaluateRequest{Key: "checkout.new_flow", EntityId: "user-1"}); v.Enabled || v.Reason != "base" || v.Variant != "" {
		t.Fatalf("база — без варианта: %+v", v)
	}

	// экспозиция и конверсия: вариант считает сервис, не вызывающий
	rep, err := srv.ReportExposure(ctx, &pb.ReportRequest{Key: "checkout.new_flow", EntityId: "user-2"})
	if err != nil || !rep.Counted || rep.Variant != "a" {
		t.Fatalf("экспозиция user-2 — вариант a: %+v / %v", rep, err)
	}
	rep, err = srv.ReportConversion(ctx, &pb.ReportRequest{Key: "checkout.new_flow", EntityId: "user-2"})
	if err != nil || !rep.Counted || rep.Variant != "a" {
		t.Fatalf("конверсия user-2 — тот же вариант: %+v / %v", rep, err)
	}

	// not_found — counted=false, не ошибка RPC
	rep, err = srv.ReportExposure(ctx, &pb.ReportRequest{Key: "ghost.flag", EntityId: "user-2"})
	if err != nil || rep.Counted {
		t.Fatalf("отчёт о несуществующем флаге — не ошибка и не счёт: %+v / %v", rep, err)
	}

	// пустой key — InvalidArgument у обоих отчётов
	if _, err := srv.ReportExposure(ctx, &pb.ReportRequest{EntityId: "u"}); codeOf(t, err) != codes.InvalidArgument {
		t.Fatalf("пустой key экспозиции — InvalidArgument: %v", err)
	}
	if _, err := srv.ReportConversion(ctx, &pb.ReportRequest{EntityId: "u"}); codeOf(t, err) != codes.InvalidArgument {
		t.Fatalf("пустой key конверсии — InvalidArgument: %v", err)
	}
}

func TestUpsertInvalidVariants(t *testing.T) {
	srv := newServer()
	ctx := context.Background()
	if _, err := srv.UpsertFlag(ctx, &pb.UpsertFlagRequest{
		Key: "bad.exp", Enabled: true,
		Variants: []*pb.Variant{
			{Name: "a", Percentage: 60},
			{Name: "b", Percentage: 60},
		},
	}); codeOf(t, err) != codes.InvalidArgument {
		t.Fatalf("сумма долей 120 — InvalidArgument: %v", err)
	}
}
