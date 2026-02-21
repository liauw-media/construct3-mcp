import { describe, it, expect } from 'vitest';

describe('smoke test', () => {
  it('vitest runs', () => {
    expect(1 + 1).toBe(2);
  });

  it('can import mocks', async () => {
    const { MockReader } = await import('./mocks/mock-reader.js');
    const { MockWriter } = await import('./mocks/mock-writer.js');
    const { MockIdGenerator } = await import('./mocks/mock-id-generator.js');
    const { MockServer } = await import('./mocks/mock-server.js');

    const reader = new MockReader();
    const writer = new MockWriter();
    const idGen = new MockIdGenerator();
    const server = new MockServer();

    expect(reader.getMetadata().name).toBe('TestProject');
    expect(writer.calls).toHaveLength(0);
    expect(await idGen.generateSid(null)).toBe(100_000_000_000_001);
    expect(server.getToolNames()).toHaveLength(0);
  });
});
