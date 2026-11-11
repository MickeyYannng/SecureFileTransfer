export class BandwidthLimiter {
  private readonly nextAvailableAt = new Map<string, number>();

  constructor(private readonly normalBytesPerSecond: number, private readonly vipBytesPerSecond: number) {}

  async throttle(userId: string, role: string, byteLength: number): Promise<void> {
    if (byteLength <= 0) return;
    const rate = role === "vip" ? this.vipBytesPerSecond : this.normalBytesPerSecond;
    const now = Date.now();
    const startAt = Math.max(now, this.nextAvailableAt.get(userId) ?? now);
    this.nextAvailableAt.set(userId, startAt + byteLength / rate * 1000);
    const delay = startAt - now;
    if (delay > 0) await new Promise<void>((resolve) => setTimeout(resolve, delay));
  }
}
