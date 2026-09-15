/**
 * Fixed-size 30-second rolling in-memory Audio Ring Buffer (PRD.md §2.3 CR-1, SPEC.md §6.1)
 *
 * Audio is processed in a rolling in-memory ring buffer and is NEVER persisted to disk,
 * never uploaded, and overwritten continuously.
 */

import { CONFIG } from "@kronos/core";

export class AudioRingBuffer {
  readonly capacity: number;
  private readonly buffer: Float32Array;
  private writeCursor = 0;
  private totalSamplesWritten = 0;

  constructor(durationSeconds = CONFIG.audio.RING_SECONDS, sampleRate = CONFIG.audio.SAMPLE_RATE) {
    this.capacity = durationSeconds * sampleRate;
    if (typeof SharedArrayBuffer !== "undefined") {
      const sab = new SharedArrayBuffer(this.capacity * Float32Array.BYTES_PER_ELEMENT);
      this.buffer = new Float32Array(sab);
    } else {
      this.buffer = new Float32Array(this.capacity);
    }
  }

  write(samples: Float32Array): void {
    const len = samples.length;
    for (let i = 0; i < len; i++) {
      this.buffer[this.writeCursor] = samples[i];
      this.writeCursor = (this.writeCursor + 1) % this.capacity;
    }
    this.totalSamplesWritten += len;
  }

  /**
   * Reads the most recent `numSamples` from the ring buffer without allocating persistent copies.
   */
  readLatest(numSamples: number): Float32Array {
    const count = Math.min(numSamples, this.capacity, this.totalSamplesWritten);
    const out = new Float32Array(count);
    const startIdx = (this.writeCursor - count + this.capacity) % this.capacity;

    for (let i = 0; i < count; i++) {
      out[i] = this.buffer[(startIdx + i) % this.capacity];
    }
    return out;
  }

  clear(): void {
    this.buffer.fill(0);
    this.writeCursor = 0;
    this.totalSamplesWritten = 0;
  }
}
