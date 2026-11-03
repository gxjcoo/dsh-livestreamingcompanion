import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// 视频平台是硬性工具边界，不能只靠 persona 提示词约束。
// 直接检查注册表，防止以后把 B 站播放工具加回来后模型再次绕过「只用抖音」。
describe('直播视频工具', () => {
  const source = readFileSync(new URL('../src/dsh/agent.ts', import.meta.url), 'utf8');
  const registered = new Set([...source.matchAll(/\bname: '([^']+)'/g)].map((match) => match[1]));

  it('只注册抖音搜索、详情和播放工具', () => {
    expect(registered).toContain('douyin_search');
    expect(registered).toContain('douyin_video');
    expect(registered).toContain('play_douyin_video');
    expect(registered).not.toContain('search_videos');
    expect(registered).not.toContain('watch_video');
    expect(registered).not.toContain('play_video');
  });
});
