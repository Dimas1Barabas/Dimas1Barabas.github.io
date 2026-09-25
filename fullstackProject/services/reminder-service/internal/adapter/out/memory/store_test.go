package memory

import (
	"context"
	"testing"
	"time"

	"reminder-service/internal/domain"
)

func scheduled(id, userID string, due time.Time) domain.Reminder {
	return domain.Reminder{
		BookingID: id, UserID: userID, Email: "u@cine.local",
		MovieTitle: "Дюна", Hall: "Красный", Seats: []string{"5-7"},
		DueAt: due, Status: domain.StatusScheduled,
	}
}

func TestScheduleDedup(t *testing.T) {
	s := NewStore()
	ctx := context.Background()
	due := time.Date(2026, 9, 25, 17, 0, 0, 0, time.UTC)

	_ = s.Schedule(ctx, scheduled("b-1", "u-1", due))
	_ = s.Schedule(ctx, scheduled("b-1", "u-1", due)) // ределивери
	_ = s.Schedule(ctx, scheduled("b-2", "u-1", due))

	got, err := s.List(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Fatalf("записей = %d, want 2 (дубль по booking_id погашен)", len(got))
	}
	// List — свежими сверху
	if got[0].BookingID != "b-2" || got[1].BookingID != "b-1" {
		t.Fatalf("порядок = [%s %s], want [b-2 b-1]", got[0].BookingID, got[1].BookingID)
	}
}

func TestCancelOnlyScheduled(t *testing.T) {
	s := NewStore()
	ctx := context.Background()
	due := time.Date(2026, 9, 25, 17, 0, 0, 0, time.UTC)

	_ = s.Schedule(ctx, scheduled("b-1", "u-1", due))
	if ok, _ := s.Cancel(ctx, "b-1"); !ok {
		t.Fatal("первая отмена = false, want true")
	}
	// повторная отмена уже погашенного — false
	if ok, _ := s.Cancel(ctx, "b-1"); ok {
		t.Fatal("повторная отмена = true, want false")
	}
	// отсутствующего — тоже false
	if ok, _ := s.Cancel(ctx, "b-нет"); ok {
		t.Fatal("отмена отсутствующего = true, want false")
	}
}

func TestDueWindow(t *testing.T) {
	s := NewStore()
	ctx := context.Background()
	now := time.Date(2026, 9, 25, 17, 0, 0, 0, time.UTC)

	_ = s.Schedule(ctx, scheduled("b-due", "u-1", now.Add(-time.Minute))) // наступило
	_ = s.Schedule(ctx, scheduled("b-later", "u-1", now.Add(time.Hour)))  // рано
	_ = s.Schedule(ctx, scheduled("b-edge", "u-1", now))                  // ровно сейчас — наступило

	due, err := s.Due(ctx, now)
	if err != nil {
		t.Fatal(err)
	}
	if len(due) != 2 {
		t.Fatalf("наступивших = %d, want 2", len(due))
	}
	for _, r := range due {
		if r.BookingID == "b-later" {
			t.Fatal("b-later попал в Due раньше времени")
		}
	}
}

func TestMarkSentExcludesFromDue(t *testing.T) {
	s := NewStore()
	ctx := context.Background()
	now := time.Date(2026, 9, 25, 17, 0, 0, 0, time.UTC)

	_ = s.Schedule(ctx, scheduled("b-1", "u-1", now.Add(-time.Minute)))
	if err := s.MarkSent(ctx, "b-1", now); err != nil {
		t.Fatal(err)
	}

	due, err := s.Due(ctx, now.Add(time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if len(due) != 0 {
		t.Fatalf("после MarkSent в Due осталось %d, want 0", len(due))
	}

	got, _ := s.List(ctx)
	if got[0].Status != domain.StatusSent || got[0].RemindedAt.IsZero() {
		t.Fatalf("запись = %+v, want SENT с RemindedAt", got[0])
	}
}
