import { Buffer } from 'node:buffer';

export const TCP_FRAME_HEADER_BYTES = 4;
export const DEFAULT_MAX_TCP_FRAME_BYTES = 1024 * 1024;

export type TcpFrameErrorCode = 'invalid-frame-size' | 'frame-too-large';

export class TcpFrameError extends Error {
  constructor(
    message: string,
    readonly code: TcpFrameErrorCode
  ) {
    super(message);
    this.name = 'TcpFrameError';
  }
}

const assertMaxFrameSize = (maxFrameBytes: number): void => {
  if (!Number.isInteger(maxFrameBytes) || maxFrameBytes < 1 || maxFrameBytes > 0xffffffff) {
    throw new TcpFrameError('maxFrameBytes must be an integer from 1 to 4294967295.', 'invalid-frame-size');
  }
};

const assertPayloadSize = (payloadBytes: number, maxFrameBytes: number): void => {
  if (payloadBytes < 1) {
    throw new TcpFrameError('TCP frames must contain a non-empty payload.', 'invalid-frame-size');
  }

  if (payloadBytes > maxFrameBytes) {
    throw new TcpFrameError(`TCP frame exceeds the ${maxFrameBytes} byte limit.`, 'frame-too-large');
  }
};

const toBuffer = (payload: Uint8Array | string): Buffer =>
  typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload);

export const encodeTcpFrame = (
  payload: Uint8Array | string,
  maxFrameBytes = DEFAULT_MAX_TCP_FRAME_BYTES
): Buffer => {
  assertMaxFrameSize(maxFrameBytes);

  const body = toBuffer(payload);
  assertPayloadSize(body.byteLength, maxFrameBytes);

  const header = Buffer.allocUnsafe(TCP_FRAME_HEADER_BYTES);
  header.writeUInt32BE(body.byteLength, 0);

  return Buffer.concat([header, body]);
};

export class TcpFrameDecoder {
  #buffer = Buffer.alloc(0);

  constructor(readonly maxFrameBytes = DEFAULT_MAX_TCP_FRAME_BYTES) {
    assertMaxFrameSize(maxFrameBytes);
  }

  push(chunk: Uint8Array): Buffer[] {
    if (chunk.byteLength === 0) {
      return [];
    }

    this.#buffer = Buffer.concat([this.#buffer, Buffer.from(chunk)]);

    const frames: Buffer[] = [];

    while (this.#buffer.byteLength >= TCP_FRAME_HEADER_BYTES) {
      const frameBytes = this.#buffer.readUInt32BE(0);
      assertPayloadSize(frameBytes, this.maxFrameBytes);

      const totalFrameBytes = TCP_FRAME_HEADER_BYTES + frameBytes;
      if (this.#buffer.byteLength < totalFrameBytes) {
        break;
      }

      frames.push(this.#buffer.subarray(TCP_FRAME_HEADER_BYTES, totalFrameBytes));
      this.#buffer = this.#buffer.subarray(totalFrameBytes);
    }

    return frames;
  }

  reset(): void {
    this.#buffer = Buffer.alloc(0);
  }

  get bufferedBytes(): number {
    return this.#buffer.byteLength;
  }
}
