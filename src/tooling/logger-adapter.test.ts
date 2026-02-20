import { describe, it, expect, vi } from 'vitest';
import { LoggerAdapter } from './logger-adapter.js';

describe('LoggerAdapter', () => {
  it('should delegate debug calls', () => {
    const debug = vi.fn();
    const adapter = new LoggerAdapter({ debug });

    adapter.debug('test message', { foo: 'bar' });

    expect(debug).toHaveBeenCalledWith('test message', { foo: 'bar' });
  });

  it('should delegate info calls to debug', () => {
    const debug = vi.fn();
    const adapter = new LoggerAdapter({ debug });

    adapter.info('test info', { foo: 'bar' });

    expect(debug).toHaveBeenCalledWith('test info', { foo: 'bar' });
  });

  it('should delegate warn calls to warn if available', () => {
    const debug = vi.fn();
    const warn = vi.fn();
    const adapter = new LoggerAdapter({ debug, warn });

    adapter.warn('test warn', { foo: 'bar' });

    expect(warn).toHaveBeenCalledWith('test warn', { foo: 'bar' });
    expect(debug).not.toHaveBeenCalled();
  });

  it('should delegate warn calls to debug if warn is not available', () => {
    const debug = vi.fn();
    const adapter = new LoggerAdapter({ debug });

    adapter.warn('test warn fallback', { foo: 'bar' });

    expect(debug).toHaveBeenCalledWith('test warn fallback', { foo: 'bar' });
  });

  it('should delegate error calls to warn if available', () => {
    const debug = vi.fn();
    const warn = vi.fn();
    const adapter = new LoggerAdapter({ debug, warn });
    const error = new Error('test error');

    adapter.error('error occurred', error, { foo: 'bar' });

    expect(warn).toHaveBeenCalledWith('error occurred', { foo: 'bar', error: 'test error' });
    expect(debug).not.toHaveBeenCalled();
  });

  it('should delegate error calls to debug if warn is not available', () => {
    const debug = vi.fn();
    const adapter = new LoggerAdapter({ debug });
    const error = new Error('test error');

    adapter.error('error fallback', error, { foo: 'bar' });

    expect(debug).toHaveBeenCalledWith('error fallback', { foo: 'bar', error: 'test error' });
  });

  it('should handle error calls without an error object', () => {
    const debug = vi.fn();
    const warn = vi.fn();
    const adapter = new LoggerAdapter({ debug, warn });

    adapter.error('error without object', undefined, { foo: 'bar' });

    expect(warn).toHaveBeenCalledWith('error without object', { foo: 'bar' });
  });
});
