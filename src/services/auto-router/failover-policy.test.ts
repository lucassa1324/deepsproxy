import test from 'node:test';
import assert from 'node:assert';
import {
  capFailoverChain,
  isPermanentFailure,
  maxAutoAttempts,
  shouldFailover,
  timeoutMs,
} from './failover-policy.ts';

test('failover: erros permanentes não disparam fallback cego', () => {
  assert.strictEqual(shouldFailover(400), false);
  assert.strictEqual(shouldFailover(401), false);
  assert.strictEqual(shouldFailover(403), false);
  assert.strictEqual(shouldFailover(422), false);
  assert.strictEqual(shouldFailover(502, '{"error":"invalid api key"}'), false);
  assert.strictEqual(isPermanentFailure(403), true);
});

test('failover: 400s convertidos em 502 pelo adapter são reconhecidos pelo corpo', () => {
  // Groq: "max_tokens must be less than or equal to 512" chega como 502
  assert.strictEqual(
    shouldFailover(
      502,
      '{"error":{"message":"`max_tokens` must be less than or equal to `512`","type":"invalid_request_error"}}'
    ),
    false
  );
  // body com "invalid request" genérico
  assert.strictEqual(shouldFailover(503, 'invalid request'), false);
  assert.strictEqual(shouldFailover(503, 'invalid_request'), false);
  // rate-limit por tokens (Groq 413->502) continua RETENTÁVEL: outro modelo pode ter janela maior
  assert.strictEqual(shouldFailover(502, '{"code":"rate_limit_exceeded","type":"tokens"}'), true);
  // 5xx puro continua retentável
  assert.strictEqual(shouldFailover(502, 'upstream crashed'), true);
});

test('failover: erros transitórios/quota disparam próximo modelo', () => {
  for (const status of [404, 408, 409, 425, 429, 500, 502, 503, 504]) {
    assert.strictEqual(shouldFailover(status), true, `status ${status} deve permitir fallback`);
  }
});

test('failover: cadeia e tentativas têm limite configurável', () => {
  assert.deepStrictEqual(capFailoverChain(['a', 'b', 'c', 'd'], 2), ['a', 'b']);
  assert.strictEqual(maxAutoAttempts('1'), 1);
  assert.strictEqual(maxAutoAttempts('99'), 10);
  assert.strictEqual(maxAutoAttempts('abc'), 3);
});

test('failover: timeout tem default e limites seguros', () => {
  assert.strictEqual(timeoutMs(''), 120_000);
  assert.strictEqual(timeoutMs('1000000'), 600_000);
  assert.strictEqual(timeoutMs('10'), 5_000);
});
