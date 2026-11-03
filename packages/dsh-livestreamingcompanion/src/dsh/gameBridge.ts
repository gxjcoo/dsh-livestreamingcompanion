/** 直播 Agent 对 dsh-game 的开局调用。结构在这里声明，不让直播包反向依赖游戏包。 */
export interface LiveGameBody {
  start(game: 'minecraft', owner: string): Promise<{
    ok: boolean;
    status: string;
    briefing: string;
    state: { status: string; game: string | null; owner: string | null };
  }>;
}

interface PlayMinecraftOptions {
  body: LiveGameBody | undefined;
  /** 后续执行 game_continue / game_act 的游戏线会话 */
  gameSession: string | null;
  goal: string;
  handoff(text: string): boolean;
}

/** 真正开好再交接；失败时不让游戏线和直播线误以为已经在玩 */
export async function playMinecraft({ body, gameSession, goal, handoff }: PlayMinecraftOptions): Promise<string> {
  if (!gameSession) return '这场直播没有准备好游戏线。确认 dsh-game 已安装并启用，然后重新开播。';
  if (!body?.start) return '没有找到 dsh-game 的游戏控制服务。安装并启用 dsh-game 后才能玩 Minecraft。';

  let started: Awaited<ReturnType<LiveGameBody['start']>>;
  try {
    // 所有权必须给游戏线，不能给直播线：否则游戏线随后的工具调用会被当成另一个会话抢局
    started = await body.start('minecraft', gameSession);
  } catch (err) {
    return `Minecraft 启动失败：${(err as Error).message}`;
  }
  if (!started.ok) return `Minecraft 没能启动：${started.status}`;

  const objective = goal.trim();
  const instruction = [
    'Minecraft 已经由直播插件通过 dsh-game 开好，不要再调 game_start。',
    objective
      ? `直播间定下目标：${objective}。先用 game_act 的 goal 记下目标，再用 game_continue 接着玩。`
      : '接着当前世界玩：用 game_continue 看现在的情况，再决定下一步。',
  ].join('\n');
  if (!handoff(`${started.briefing}\n\n${instruction}`)) return `Minecraft 已启动，但游戏线现在接不到交接：${started.status}`;
  return `${started.status}\nMinecraft 已通过 dsh-game 启动，游戏线会接着操作和解说，画面会自动交给直播舞台。`;
}
