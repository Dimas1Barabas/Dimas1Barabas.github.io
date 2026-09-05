/**
 * Утилиты чтения SSE-потока в тестах: фреймы из fetch-ответа
 * и ожидание события с таймаутом (иначе тест зависнет на вечном стриме).
 */

export interface SseFrame {
  event: string;
  data: string;
}

/** асинхронный итератор по SSE-фреймам ответа fetch */
export async function* sseFrames(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const raw = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      yield {
        event: /event: (.*)/.exec(raw)?.[1] ?? 'message',
        data: /^data: (.*)$/m.exec(raw)?.[1] ?? '',
      };
    }
  }
}

/**
 * Ждёт из стрима событие типа `type`, чей data проходит `where`.
 * Если за `timeoutMs` ничего не пришло — бросает ошибку.
 */
export async function waitForSseEvent<T>(
  frames: AsyncGenerator<SseFrame>,
  type: string,
  where: (payload: T) => boolean,
  timeoutMs = 5000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remain = deadline - Date.now();
    const timeout = new Promise<'timeout'>((resolve) =>
      setTimeout(() => resolve('timeout'), remain),
    );
    const next = await Promise.race([frames.next(), timeout]);
    if (next === 'timeout') break;
    if (next.done) break;
    const { event, data } = next.value;
    if (event !== type || !data) continue;
    const payload = JSON.parse(data) as T;
    if (where(payload)) return payload;
  }
  throw new Error(`SSE-событие «${type}» не дождались за ${timeoutMs} мс`);
}
