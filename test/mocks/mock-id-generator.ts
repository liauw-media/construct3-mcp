/**
 * Deterministic ID generator for testing.
 * SIDs start at 100000000000001 and increment.
 * UIDs start at 1 and increment.
 * ImageSpriteIds start at 1000001 and increment.
 */

export class MockIdGenerator {
  private nextSid = 100_000_000_000_001;
  private nextUid = 1;
  private nextImageSpriteId = 1_000_001;

  async generateSid(_reader: unknown): Promise<number> {
    return this.nextSid++;
  }

  async generateUid(_reader: unknown): Promise<number> {
    return this.nextUid++;
  }

  async generateImageSpriteId(_reader: unknown): Promise<number> {
    return this.nextImageSpriteId++;
  }

  addSid(_sid: number): void {
    // no-op
  }

  addUid(_uid: number): void {
    // no-op
  }

  reset(): void {
    this.nextSid = 100_000_000_000_001;
    this.nextUid = 1;
    this.nextImageSpriteId = 1_000_001;
  }
}
