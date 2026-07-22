// Traces: BASED-ROWCAP
import type { WireValue } from "./types";

export const DEFAULT_ROW_CAP = 50_000;
const CHUNK_SIZE = 500;

/** Buffers rows, flushes in chunks, drops rows past the cap while still counting the true total. */
export class RowCollector {
  private buffer: WireValue[][] = [];
  private count = 0;

  constructor(
    private readonly flush: (rows: WireValue[][]) => void,
    private readonly cap: number = DEFAULT_ROW_CAP,
    private readonly chunkSize: number = CHUNK_SIZE,
  ) {}

  push(row: WireValue[]): void {
    this.count++;
    if (this.count > this.cap) return;
    this.buffer.push(row);
    if (this.buffer.length >= this.chunkSize) this.drain();
  }

  private drain(): void {
    if (this.buffer.length > 0) {
      this.flush(this.buffer);
      this.buffer = [];
    }
  }

  finish(): { rowCount: number; truncated: boolean } {
    this.drain();
    return { rowCount: this.count, truncated: this.count > this.cap };
  }
}
