import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CameraPreview, FrameDecoder } from '../src/games/minecraft/cameraPreview';

const packet = (data: Buffer): Buffer => {
  const size = Buffer.alloc(4);
  size.writeUInt32LE(data.length);
  return Buffer.concat([size, data]);
};

describe('Minecraft camera preview framing', () => {
  it('decodes partial and coalesced frames without mixing their bytes', () => {
    const decoder = new FrameDecoder();
    const first = Buffer.from([1, 2, 3]);
    const second = Buffer.from([4, 5]);
    const bytes = Buffer.concat([packet(first), packet(second)]);
    expect(decoder.push(bytes.subarray(0, 5))).toEqual([]);
    expect(decoder.push(bytes.subarray(5))).toEqual([first, second]);
  });

  it('rejects an invalid stream instead of allocating an unbounded frame', () => {
    const header = Buffer.alloc(4);
    header.writeUInt32LE(0xffffffff);
    expect(() => new FrameDecoder().push(header)).toThrow('invalid preview frame size');
  });

  const livePid = Number(process.env.DSH_TEST_CAMERA_PID) || 0;
  it.runIf(process.platform === 'win32' && livePid > 0)('captures consecutive JPEG frames from a real camera window', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-camera-preview-'));
    const frames: Buffer[] = [];
    const preview = new CameraPreview(dir, (frame) => frames.push(frame), (text) => console.error(text));
    try {
      preview.start(livePid, 5);
      await vi.waitFor(() => expect(frames.length).toBeGreaterThanOrEqual(3), { timeout: 15_000 });
      for (const frame of frames) {
        expect(frame[0]).toBe(0xff);
        expect(frame[1]).toBe(0xd8);
        expect(frame.at(-2)).toBe(0xff);
        expect(frame.at(-1)).toBe(0xd9);
      }
      if (process.env.DSH_TEST_PREVIEW_OUT) fs.writeFileSync(process.env.DSH_TEST_PREVIEW_OUT, frames.at(-1)!);
    } finally {
      preview.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
