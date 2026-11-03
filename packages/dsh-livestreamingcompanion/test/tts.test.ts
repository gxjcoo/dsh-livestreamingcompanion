import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
});

/** 造一条豆包单向流式响应：几行 NDJSON */
const streamBody = (...lines: string[]): Response =>
  new Response(lines.join('\n'), { status: 200, headers: { 'content-type': 'text/plain' } });

describe('synthesize', () => {
  it('跳过非 JSON 行，音频照常拼出来', async () => {
    const audio = Buffer.from('ID3-fake-mp3');
    vi.stubGlobal('fetch', async () =>
      streamBody(
        // 风控页 / SSE 前缀 / 被截断的行：都不该让整句合成失败
        '<html><body>403 Forbidden</body></html>',
        'data: {"code":20000000}',
        JSON.stringify({ code: 20000000, message: '' }),
        JSON.stringify({ data: audio.toString('base64') }),
      ),
    );
    const { synthesize, DEFAULT_VOICE } = await import('../src/body/tts');
    const speech = await synthesize({ apiKey: 'test-key' }, DEFAULT_VOICE, '你好', new AbortController().signal);
    expect(Buffer.from(speech.audio).toString()).toBe('ID3-fake-mp3');
  });

  it('服务端错误码仍然要抛出来', async () => {
    vi.stubGlobal('fetch', async () => streamBody(JSON.stringify({ code: 30000001, message: 'invalid speaker' })));
    const { synthesize, DEFAULT_VOICE } = await import('../src/body/tts');
    await expect(synthesize({ apiKey: 'test-key' }, DEFAULT_VOICE, '你好', new AbortController().signal)).rejects.toThrow(
      /30000001|invalid speaker/,
    );
  });

  it('只带逐字时间的行也能解析出 words', async () => {
    vi.stubGlobal('fetch', async () =>
      streamBody(
        JSON.stringify({ sentence: { words: [{ word: '你', startTime: 0, endTime: 0.2 }] } }),
        JSON.stringify({ sentence: { words: [{ word: '好', startTime: 0.2, endTime: 0.5 }, { word: '', startTime: 0, endTime: 0 }] } }),
      ),
    );
    const { synthesize, DEFAULT_VOICE } = await import('../src/body/tts');
    const speech = await synthesize({ apiKey: 'test-key' }, DEFAULT_VOICE, '你好', new AbortController().signal);
    expect(speech.words.map((w) => w.word)).toEqual(['你', '好']);
  });
});

describe('toMp3', () => {
  const restore = (prev: string | undefined): void => {
    if (prev === undefined) delete process.env.DSH_LIVESTREAM_FFMPEG;
    else process.env.DSH_LIVESTREAM_FFMPEG = prev;
  };

  it('ffmpeg 起不来时返回 null 而不是崩掉进程', async () => {
    const prev = process.env.DSH_LIVESTREAM_FFMPEG;
    // 指向一个不存在的可执行文件：spawn 失败 → error 事件 → 写 stdin 会 EPIPE。
    // 修复前 stdin 没有 error 监听，这个 EPIPE 是未捕获异常，会带走整个宿主进程。
    process.env.DSH_LIVESTREAM_FFMPEG = 'C:\\__dsh_no_such_ffmpeg__.exe';
    try {
      const { toMp3 } = await import('../src/body/tts');
      await expect(toMp3(Buffer.alloc(64 * 1024, 7))).resolves.toBeNull();
    } finally {
      restore(prev);
    }
  });

  it('信号已经 abort 时立即收手', async () => {
    const prev = process.env.DSH_LIVESTREAM_FFMPEG;
    process.env.DSH_LIVESTREAM_FFMPEG = 'C:\\__dsh_no_such_ffmpeg__.exe';
    try {
      const { toMp3 } = await import('../src/body/tts');
      await expect(toMp3(Buffer.alloc(1024, 7), AbortSignal.abort())).resolves.toBeNull();
    } finally {
      restore(prev);
    }
  });
});
