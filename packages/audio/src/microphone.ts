/**
 * Real microphone capture for KRONOS (SPEC.md §6.1, CR-1, CR-2).
 *
 * Opens the user's microphone via getUserMedia, runs the stream through an
 * AudioWorklet, and delivers fixed-size 16 kHz mono Float32 frames to the VAD
 * and the rolling ring buffer.
 *
 * Browser-only by necessity — getUserMedia and AudioWorklet do not exist in
 * Node. The eval harness feeds recorded WAV files through the same downstream
 * path instead (see @kronos/audio/wav).
 *
 * PRIVACY INVARIANTS
 * ------------------
 * CR-1: audio exists only in a fixed-size in-memory ring buffer that overwrites
 *       itself continuously. Nothing is written to disk, IndexedDB, or the
 *       network. Stopping the session drops the buffer.
 * CR-2: the microphone is only ever opened through this class, and every open
 *       flips an observable state that the UI renders as a persistent indicator.
 *       There is no code path that captures audio without the dot being lit.
 */

import { CONFIG } from "@kronos/core";
import { AudioRingBuffer } from "./ring-buffer.js";

export type MicState = "idle" | "requesting" | "live" | "denied" | "error";

export interface MicrophoneEvents {
  /** Fires for every captured frame of FRAME_SAMPLES samples. */
  onFrame?: (frame: Float32Array, atMs: number) => void;
  /** Fires whenever capture state changes — drives the CR-2 indicator. */
  onStateChange?: (state: MicState, detail?: string) => void;
}

/**
 * The AudioWorklet processor, inlined as a string.
 *
 * It ships as a Blob URL rather than a separate .js file because the worklet
 * must be same-origin, and a blob: URL inherits the page origin without needing
 * a build step to copy an asset into the right public path.
 *
 * The processor does the minimum possible work on the audio thread: accumulate
 * samples into a fixed-size frame and post it. Any real computation here causes
 * audible glitching, because this callback runs on a hard real-time deadline.
 */
const WORKLET_SOURCE = `
class KronosCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.frameSize = options.processorOptions.frameSize;
    this.buffer = new Float32Array(this.frameSize);
    this.filled = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;

    // Channel 0 only. getUserMedia is requested with channelCount: 1, but some
    // drivers hand back more anyway.
    const channel = input[0];
    if (!channel) return true;

    for (let i = 0; i < channel.length; i++) {
      this.buffer[this.filled++] = channel[i];
      if (this.filled === this.frameSize) {
        // Transfer a copy; the worklet reuses its own buffer next frame.
        this.port.postMessage(this.buffer.slice());
        this.filled = 0;
      }
    }
    return true;
  }
}
registerProcessor("kronos-capture", KronosCaptureProcessor);
`;

export class MicrophoneCapture {
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private workletUrl: string | null = null;

  private _state: MicState = "idle";
  private readonly events: MicrophoneEvents;

  /** 30-second rolling buffer. Never persisted (CR-1). */
  readonly ring = new AudioRingBuffer(
    CONFIG.audio.RING_SECONDS,
    CONFIG.audio.SAMPLE_RATE
  );


  constructor(events: MicrophoneEvents = {}) {
    this.events = events;
  }

  get state(): MicState {
    return this._state;
  }

  /** True whenever live audio is being captured. Drives the CR-2 indicator. */
  get isLive(): boolean {
    return this._state === "live";
  }

  private setState(state: MicState, detail?: string): void {
    this._state = state;
    this.events.onStateChange?.(state, detail);
  }

  async start(): Promise<void> {
    if (this._state === "live") return;

    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      this.setState("error", "getUserMedia unavailable (not a secure browser context)");
      throw new Error("MicrophoneCapture requires a browser with getUserMedia");
    }

    this.setState("requesting");

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          // Browser DSP is left ON deliberately. Negotiations happen in rooms
          // with air conditioning and a speakerphone, and the platform AEC/NS
          // implementations are considerably better than anything reimplemented
          // here. The far-field case is the dominant accuracy risk.
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const denied = /permission|denied|notallowed/i.test(message);
      this.setState(denied ? "denied" : "error", message);
      throw err;
    }

    // Request the graph at 16 kHz so the browser resamples natively and Whisper
    // gets exactly the rate it expects with no resampling of our own.
    this.context = new AudioContext({ sampleRate: CONFIG.audio.SAMPLE_RATE });

    const blob = new Blob([WORKLET_SOURCE], { type: "application/javascript" });
    this.workletUrl = URL.createObjectURL(blob);
    await this.context.audioWorklet.addModule(this.workletUrl);

    this.source = this.context.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.context, "kronos-capture", {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      processorOptions: { frameSize: CONFIG.audio.FRAME_SAMPLES },
    });

    this.node.port.onmessage = (event: MessageEvent<Float32Array>) => {
      const frame = event.data;
      this.ring.write(frame);
      this.events.onFrame?.(frame, performance.now());
    };

    this.source.connect(this.node);
    // Note: the worklet is deliberately NOT connected to context.destination.
    // Routing captured microphone audio to the speakers during a live meeting
    // would create feedback.

    this.setState("live");
  }

  /**
   * Stops capture and releases the microphone.
   *
   * Every track is explicitly stopped so the browser's recording indicator goes
   * out. Merely closing the AudioContext leaves tracks live, and a product that
   * claims a hard privacy guarantee cannot leave the OS mic indicator on.
   */
  async stop(): Promise<void> {
    this.node?.port.close();
    this.node?.disconnect();
    this.source?.disconnect();

    for (const track of this.stream?.getTracks() ?? []) {
      track.stop();
    }

    if (this.context && this.context.state !== "closed") {
      await this.context.close();
    }

    if (this.workletUrl) {
      URL.revokeObjectURL(this.workletUrl);
      this.workletUrl = null;
    }

    this.node = null;
    this.source = null;
    this.stream = null;
    this.context = null;

    // Drop buffered audio immediately rather than waiting for it to age out.
    this.ring.clear();

    this.setState("idle");
  }
}
