// Package logging — slog-логгер: JSON-строки в stdout, каждая несёт
// trace_id/span_id активного спана из контекста записи. Строки парсит
// Alloy и складывает в Loki, где по trace_id лог линкуется в трейс Jaeger.
//
// Printf-хелперы (Infof/Warnf/Errorf) сохраняют формат бывшего log.Printf —
// точки вызова мигрируют одной строкой; контекст у записи даёт корреляцию
// с трейсом (вне спана trace_id просто не пишется). Функции без контекста
// (Info/Warn/Fatalf) — стартовые строки и фоновые горутины.
package logging

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"

	"go.opentelemetry.io/otel/trace"
)

// Setup ставит дефолтный логгер: JSONHandler в stdout, обёрнутый
// traceHandler'ом. Вызывается в main ДО tracing.Setup — диагностические
// строки трейсинга тоже уходят JSON'ом.
func Setup() {
	slog.SetDefault(slog.New(NewHandler(os.Stdout)))
}

// NewHandler строит JSON-хендлер с трейс-контекстом — для main и тестов.
func NewHandler(w io.Writer) slog.Handler {
	return &traceHandler{inner: slog.NewJSONHandler(w, nil)}
}

// traceHandler добавляет к каждой записи атрибуты спана из её контекста.
type traceHandler struct {
	inner slog.Handler
}

func (h *traceHandler) Enabled(ctx context.Context, level slog.Level) bool {
	return h.inner.Enabled(ctx, level)
}

func (h *traceHandler) Handle(ctx context.Context, r slog.Record) error {
	if sc := trace.SpanContextFromContext(ctx); sc.IsValid() {
		r.AddAttrs(
			slog.String("trace_id", sc.TraceID().String()),
			slog.String("span_id", sc.SpanID().String()),
		)
	}
	return h.inner.Handle(ctx, r)
}

func (h *traceHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	return &traceHandler{inner: h.inner.WithAttrs(attrs)}
}

func (h *traceHandler) WithGroup(name string) slog.Handler {
	return &traceHandler{inner: h.inner.WithGroup(name)}
}

// Printf-хелперы с контекстом — основной путь точек вызова.

func Infof(ctx context.Context, format string, args ...any) {
	slog.InfoContext(ctx, fmt.Sprintf(format, args...))
}

func Warnf(ctx context.Context, format string, args ...any) {
	slog.WarnContext(ctx, fmt.Sprintf(format, args...))
}

func Errorf(ctx context.Context, format string, args ...any) {
	slog.ErrorContext(ctx, fmt.Sprintf(format, args...))
}

// Без контекста: старт и фон вне спанов — trace_id у них не бывает.

func Info(format string, args ...any) {
	slog.Info(fmt.Sprintf(format, args...))
}

func Warn(format string, args ...any) {
	slog.Warn(fmt.Sprintf(format, args...))
}

func Error(format string, args ...any) {
	slog.Error(fmt.Sprintf(format, args...))
}

// Fatalf — fatal конфигурации: последняя строка перед выходом.
func Fatalf(format string, args ...any) {
	slog.Error(fmt.Sprintf(format, args...))
	os.Exit(1)
}
