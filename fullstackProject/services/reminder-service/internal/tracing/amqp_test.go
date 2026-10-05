package tracing

import (
	"context"
	"fmt"
	"strings"
	"testing"

	amqp "github.com/rabbitmq/amqp091-go"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"
)

// installTracer ставит глобальный провайдер с in-memory экспортером —
// без него глобальный TracerProvider no-op и заголовки не пишутся.
func installTracer(t *testing.T) *tracetest.InMemoryExporter {
	t.Helper()
	exp := tracetest.NewInMemoryExporter()
	tp := sdktrace.NewTracerProvider(
		sdktrace.WithSpanProcessor(sdktrace.NewSimpleSpanProcessor(exp)),
	)
	otel.SetTracerProvider(tp)
	otel.SetTextMapPropagator(propagation.TraceContext{})
	t.Cleanup(func() { _ = tp.Shutdown(context.Background()) })
	return exp
}

// traceparent валидного спана: 00-<traceId>-<spanId>-01
func traceparentOf(span trace.Span) string {
	sc := span.SpanContext()
	return fmt.Sprintf("00-%s-%s-01", sc.TraceID(), sc.SpanID())
}

func TestTableCarrier(t *testing.T) {
	table := amqp.Table{}
	carrier := tableCarrier(table)
	carrier.Set("traceparent", "00-abc-def-01")
	if got := carrier.Get("traceparent"); got != "00-abc-def-01" {
		t.Fatalf("Get вернул %q", got)
	}
	if got := carrier.Get("нет-такого"); got != "" {
		t.Fatalf("пустой ключ вернул %q", got)
	}
	// не-строковое значение не должно валить Get
	table["num"] = 42
	if got := carrier.Get("num"); got != "" {
		t.Fatalf("не-строка вернула %q", got)
	}
	if len(carrier.Keys()) != 2 {
		t.Fatalf("Keys: %v", carrier.Keys())
	}
}

func TestInjectHeaders(t *testing.T) {
	installTracer(t)

	// вне активного спана заголовков нет
	if headers := InjectHeaders(context.Background()); len(headers) != 0 {
		t.Fatalf("без спана вернулись заголовки: %v", headers)
	}

	ctx, span := otel.Tracer("spec").Start(context.Background(), "parent")
	headers := InjectHeaders(ctx)
	tp, ok := headers["traceparent"].(string)
	if !ok {
		t.Fatalf("traceparent не записан: %v", headers)
	}
	want := traceparentOf(span)
	if tp != want {
		t.Fatalf("traceparent %q != ожидаемому %q", tp, want)
	}
}

func TestConsumeSpanExtractsParent(t *testing.T) {
	exp := installTracer(t)

	_, parent := otel.Tracer("spec").Start(context.Background(), "publisher")
	headers := InjectHeaders(trace.ContextWithSpan(context.Background(), parent))
	parent.End()

	d := amqp.Delivery{
		RoutingKey: "booking.processed",
		Headers:    headers,
	}
	_, span := ConsumeSpan(d, "worker.booking.created")
	if span.SpanContext().TraceID() != parent.SpanContext().TraceID() {
		t.Fatalf("трейс не продолжен: %s != %s",
			span.SpanContext().TraceID(), parent.SpanContext().TraceID())
	}
	span.End()

	// publisher + consumer — трейс целиком в одном экспортере
	spans := exp.GetSpans()
	if len(spans) != 2 {
		t.Fatalf("спанов %d, хочу 2", len(spans))
	}
	var got tracetest.SpanStub
	for _, s := range spans {
		if s.Name == "rabbit.consume booking.processed" {
			got = s
		}
	}
	if got.Name == "" {
		t.Fatalf("консьюмер-спан не найден среди %v", spans)
	}
	if got.SpanKind != trace.SpanKindConsumer {
		t.Fatalf("kind %v", got.SpanKind)
	}
	if got.Parent.SpanID() != parent.SpanContext().SpanID() {
		t.Fatalf("родитель %s != %s", got.Parent.SpanID(), parent.SpanContext().SpanID())
	}
	if !strings.Contains(fmt.Sprint(got.Attributes), "worker.booking.created") {
		t.Fatalf("атрибут очереди не записан: %v", got.Attributes)
	}
}

func TestConsumeSpanWithoutHeaders(t *testing.T) {
	installTracer(t)

	_, span := ConsumeSpan(amqp.Delivery{RoutingKey: "rk.bare"}, "q")
	if !span.SpanContext().IsValid() {
		t.Fatal("без заголовков спан должен быть корневым, но валидным")
	}
	span.End()
}

func TestMarkErrorNoop(t *testing.T) {
	// без провайдера SpanFromContext — no-op: не паникует и не пишет
	MarkError(context.Background(), fmt.Errorf("db down"))
}

func TestSetupWithoutEndpoint(t *testing.T) {
	t.Setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "")
	shutdown := Setup("ticket-worker")
	if err := shutdown(context.Background()); err != nil {
		t.Fatalf("shutdown вернул ошибку: %v", err)
	}
}
