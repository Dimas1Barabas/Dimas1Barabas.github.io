// Package webhook — исходящий адаптер «Почтальона»: доставляет конверты
// партнёрам по HTTP и подписывает их HMAC-SHA256. Успех — 2xx; всё
// остальное (сеть, таймаут, 4xx/5xx) — неудача: расписание ретраев и
// DLQ решает use-case, адаптер только честно сообщает вердикт.
package webhook

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"

	"postman-service/internal/domain"
)

// Заголовки доставки — контракт партнёра: подпись, время подписи,
// тип события и id доставки (партнёр гасит повторы по нему).
const (
	HeaderSignature = "X-CB-Signature"
	HeaderTimestamp = "X-CB-Timestamp"
	HeaderEvent     = "X-CB-Event"
	HeaderDelivery  = "X-CB-Delivery"
)

// Client — WebhookSender поверх http.Client с таймаутом.
type Client struct {
	http *http.Client
}

// New — клиент с таймаутом одного POST (ретраи не здесь: расписание
// ведёт use-case, адаптер без состояния).
func New(timeout time.Duration) *Client {
	return &Client{http: &http.Client{Timeout: timeout}}
}

// Send собирает тело конверта, ставит подпись и заголовки, POST-ит.
// Подпись: hex(HMAC-SHA256(secret, "<unix-секунды>.<тело>")) — время
// в материале подписи защищает от воспроизведения перехваченного
// запроса позже (окно проверяет партнёр).
func (c *Client) Send(ctx context.Context, sub domain.Subscription, env domain.Envelope) error {
	body, err := json.Marshal(env)
	if err != nil {
		return fmt.Errorf("сборка конверта %s: %w", env.DeliveryID, err)
	}
	ts := strconv.FormatInt(time.Now().Unix(), 10)
	signature := Sign(sub.Secret, ts, body)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, sub.URL, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("запрос к %s: %w", sub.URL, err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(HeaderSignature, signature)
	req.Header.Set(HeaderTimestamp, ts)
	req.Header.Set(HeaderEvent, env.Type)
	req.Header.Set(HeaderDelivery, env.DeliveryID)
	// трейс продолжается и в партнёрскую сторону: W3C traceparent
	otel.GetTextMapPropagator().Inject(ctx, propagation.HeaderCarrier(req.Header))

	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("POST %s: %w", sub.URL, err)
	}
	defer func() { _ = resp.Body.Close() }()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4<<10))

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("HTTP %d от %s", resp.StatusCode, sub.URL)
	}
	return nil
}

// Sign — подпись материала «<unix-секунды>.<тело>» ключом подписки.
// Вынесена отдельно: e2e и партнёры проверяют подпись той же функцией
// (контракт, а не деталь адаптера).
func Sign(secret, timestamp string, body []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(timestamp + "." + string(body)))
	return "sha256=" + hex.EncodeToString(mac.Sum(nil))
}

// Verify — проверка подписи партнёром (и тестами): постоянное время
// сравнения — timing-атаки на equality здесь неуместны.
func Verify(secret, timestamp string, body []byte, signature string) bool {
	expected := Sign(secret, timestamp, body)
	return hmac.Equal([]byte(expected), []byte(signature))
}
