import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_TCP_FRAME_BYTES,
  TCP_FRAME_HEADER_BYTES,
  TcpFrameDecoder,
  TcpFrameError,
  encodeTcpFrame
} from './framing';

describe('TCP length-prefixed framing', () => {
  it('encodes a payload with a 4-byte big-endian length prefix', () => {
    const frame = encodeTcpFrame('hello');

    expect(frame.readUInt32BE(0)).toBe(5);
    expect(frame.subarray(TCP_FRAME_HEADER_BYTES).toString('utf8')).toBe('hello');
  });

  it('waits for partial frames before emitting payloads', () => {
    const decoder = new TcpFrameDecoder();
    const frame = encodeTcpFrame('chunked frame');

    expect(decoder.push(frame.subarray(0, 2))).toEqual([]);
    expect(decoder.bufferedBytes).toBe(2);
    expect(decoder.push(frame.subarray(2, 7))).toEqual([]);

    const frames = decoder.push(frame.subarray(7));

    expect(frames.map((payload) => payload.toString('utf8'))).toEqual(['chunked frame']);
    expect(decoder.bufferedBytes).toBe(0);
  });

  it('emits multiple frames from one TCP chunk', () => {
    const decoder = new TcpFrameDecoder();
    const chunk = Buffer.concat([encodeTcpFrame('first'), encodeTcpFrame('second'), encodeTcpFrame('third')]);

    const frames = decoder.push(chunk);

    expect(frames.map((payload) => payload.toString('utf8'))).toEqual(['first', 'second', 'third']);
    expect(decoder.bufferedBytes).toBe(0);
  });

  it('emits complete frames and keeps an incomplete trailing frame buffered', () => {
    const decoder = new TcpFrameDecoder();
    const completeFrame = encodeTcpFrame('ready');
    const partialFrame = encodeTcpFrame('later').subarray(0, TCP_FRAME_HEADER_BYTES + 2);

    const frames = decoder.push(Buffer.concat([completeFrame, partialFrame]));

    expect(frames.map((payload) => payload.toString('utf8'))).toEqual(['ready']);
    expect(decoder.bufferedBytes).toBe(TCP_FRAME_HEADER_BYTES + 2);
  });

  it('rejects empty frames as malformed data', () => {
    const decoder = new TcpFrameDecoder();
    const malformedFrame = Buffer.alloc(TCP_FRAME_HEADER_BYTES);

    expect(() => decoder.push(malformedFrame)).toThrow(TcpFrameError);
    expect(() => encodeTcpFrame(Buffer.alloc(0))).toThrow('TCP frames must contain a non-empty payload.');
  });

  it('rejects frames larger than the configured limit', () => {
    const decoder = new TcpFrameDecoder(8);
    const oversizedHeader = Buffer.alloc(TCP_FRAME_HEADER_BYTES);
    oversizedHeader.writeUInt32BE(9, 0);

    expect(() => decoder.push(oversizedHeader)).toThrow('TCP frame exceeds the 8 byte limit.');
    expect(() => encodeTcpFrame('too large', 8)).toThrow('TCP frame exceeds the 8 byte limit.');
  });

  it('validates maximum frame-size configuration', () => {
    expect(() => new TcpFrameDecoder(0)).toThrow('maxFrameBytes must be an integer from 1 to 4294967295.');
    expect(() => encodeTcpFrame('hello', 1.5)).toThrow('maxFrameBytes must be an integer from 1 to 4294967295.');
    expect(DEFAULT_MAX_TCP_FRAME_BYTES).toBe(1024 * 1024);
  });

  it('can reset malformed buffered data before decoding new frames', () => {
    const decoder = new TcpFrameDecoder(8);
    const oversizedHeader = Buffer.alloc(TCP_FRAME_HEADER_BYTES);
    oversizedHeader.writeUInt32BE(9, 0);

    expect(() => decoder.push(oversizedHeader)).toThrow(TcpFrameError);
    expect(decoder.bufferedBytes).toBe(TCP_FRAME_HEADER_BYTES);

    decoder.reset();
    const frames = decoder.push(encodeTcpFrame('ok', 8));

    expect(frames.map((payload) => payload.toString('utf8'))).toEqual(['ok']);
    expect(decoder.bufferedBytes).toBe(0);
  });
});
