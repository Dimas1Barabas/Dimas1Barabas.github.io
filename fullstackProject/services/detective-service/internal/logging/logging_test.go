package logging

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"strings"
	"testing"

	"go.opentelemetry.io/otel"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
)

// Логгер герметично: настоящий TracerProvider с in-memory экспортером,
// вывод ловим в буфер — ровно те JSON-строки, что уедут в docker-лог.

type spanAttrs struct {
	TraceID string `json:"trace_id"`
	SpanID  string `json:"span_id"`
	Level   string `json:"level"`
	Msg     string `json:"msg"`
}

func parseLine(t *testing.T, out string) spanAttrs {
	t.Helper()
	line := strings.TrimSpace(out)
	if !strings.HasPrefix(line, "{") {
		t.Fatalf("строка не JSON: %q", line)
	}
	var attrs spanAttrs
	if err := json.Unmarshal([]byte(line), &attrs); err != nil {
		t.Fatalf("не разбирается: %v", err)
	}
	return attrs
}

func TestHandleAddsSpanAttrs(t *testing.T) {
	exp := tracetest.NewInMemoryExporter()
	tp := sdktrace.NewTracerProvider(
		sdktrace.WithSpanProcessor(sdktrace.NewSimpleSpanProcessor(exp)))
	defer func() { _ = tp.Shutdown(context.Background()) }()
	old := otel.GetTracerProvider()
	otel.SetTracerProvider(tp)
	t.Cleanup(func() { otel.SetTracerProvider(old) })

	var buf bytes.Buffer
	logger := slog.New(NewHandler(&buf))

	// Start возвращает контекст со встроенным спаном — его и логируем
	spanCtx, span := tp.Tracer("test").Start(context.Background(), "booking.processed")
	logger.InfoContext(spanCtx, "вердикт")
	want := span.SpanContext()
	span.End()

	got := parseLine(t, buf.String())
	if got.TraceID != want.TraceID().String() {
		t.Errorf("trace_id = %q, хочу %q", got.TraceID, want.TraceID())
	}
	if got.SpanID != want.SpanID().String() {
		t.Errorf("span_id = %q, хочу %q", got.SpanID, want.SpanID())
	}
	if got.Level != "INFO" {
		t.Errorf("level = %q, хочу INFO", got.Level)
	}
}

func TestHandleWithoutSpanOmitsAttrs(t *testing.T) {
	var buf bytes.Buffer
	slog.New(NewHandler(&buf)).Warn("тарификатор недоступен")

	got := parseLine(t, buf.String())
	if got.TraceID != "" || got.SpanID != "" {
		t.Errorf("вне спана атрибутов быть не должно, получили %+v", got)
	}
}

func TestInfofFormatsMessage(t *testing.T) {
	var buf bytes.Buffer
	old := slog.Default()
	slog.SetDefault(slog.New(NewHandler(&buf)))
	t.Cleanup(func() { slog.SetDefault(old) })

	Infof(context.Background(), "← %s: %d ₽", "b-42", 500)
	got := parseLine(t, buf.String())
	if got.Msg != "← b-42: 500 ₽" || got.Level != "INFO" {
		t.Errorf("строка = %+v", got)
	}
}

func TestWithAttrsKeepsHandlerChain(t *testing.T) {
	var buf bytes.Buffer
	h := NewHandler(&buf).WithAttrs([]slog.Attr{slog.String("svc", "ticket-worker")})
	slog.New(h).Info("привет")

	if !strings.Contains(buf.String(), `"svc":"ticket-worker"`) {
		t.Errorf("атрибут WithAttrs потерялся: %s", buf.String())
	}
}
