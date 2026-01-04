import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DynamicMockEngine } from './dynamic-mock-server.js';
import { OpenAPIParser } from '../openapi-parser.js';

const parserStub = {
  getOperation: (operationId: string) => ({
    operationId,
    method: 'POST',
    path: '/resource/{id}'
  })
} as unknown as OpenAPIParser;

describe('DynamicMockEngine', () => {
  let engine: DynamicMockEngine;

  beforeEach(() => {
    engine = new DynamicMockEngine(parserStub, 'https://mock.local');
    engine.start();
  });

  afterEach(() => {
    engine.stop();
  });

  it('captures request details for mocked operations', async () => {
    engine.configureMocks([
      { operationId: 'opWithBody', response: { body: { ok: true } } }
    ]);

    await fetch('https://mock.local/resource/123?flag=true&flag=false', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-test': 'yes'
      },
      body: JSON.stringify({ value: 1 })
    });

    const captured = engine.getCapturedRequests();
    expect(captured).toHaveLength(1);
    expect(captured[0].method).toBe('POST');
    expect(captured[0].path).toBe('/resource/123');
    expect(captured[0].origin).toBe('https://mock.local');
    expect(captured[0].query.flag).toEqual(['true', 'false']);
    expect(captured[0].headers['x-test']).toBe('yes');
    expect(captured[0].body).toEqual({ value: 1 });
  });

  it('resets handlers and captured requests', async () => {
    engine.configureMocks([
      { operationId: 'opWithBody', response: { body: { ok: true } } }
    ]);

    await fetch('https://mock.local/resource/123', { method: 'POST' });
    expect(engine.getCapturedRequests()).toHaveLength(1);

    engine.reset();
    expect(engine.getCapturedRequests()).toHaveLength(0);

    engine.configureMocks([
      { operationId: 'opWithBody', response: { body: { ok: true } } }
    ]);
    await fetch('https://mock.local/resource/123', { method: 'POST' });

    expect(engine.getCapturedRequests()).toHaveLength(1);
  });
});
