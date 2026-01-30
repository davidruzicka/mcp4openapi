import { describe, it, expect } from 'vitest';
import * as lib from './lib.js';

describe('lib exports', () => {
  it('exposes core exports', () => {
    expect(lib.MCPServer).toBeDefined();
    expect(lib.HttpTransport).toBeDefined();
    expect(lib.ConsoleLogger).toBeDefined();
    expect(lib.JsonLogger).toBeDefined();
  });
});
