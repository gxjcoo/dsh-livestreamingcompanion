/**
 * 给其他插件用的游戏控制服务。直播插件通过它真正开一局游戏，不再只靠提示词转达。
 * 对局仍由 games 里唯一的 GameSession 实现；owner 必须是后续操作这局的 Agent 会话。
 */
import { games, type GameId, type GameState } from './runtime.js';

export interface GameStartResult {
  ok: boolean;
  /** dsh-game 开局时返回的事实或失败原因，原样交给调用它的 Agent */
  status: string;
  /** 交给后续操作这局的游戏 Agent：规则和开局现状，与 game_start 工具返回的内容一致 */
  briefing: string;
  state: GameState;
}

export const gameBody = {
  async start(game: GameId, owner: string): Promise<GameStartResult> {
    const status = await games.start(game, owner);
    const state = games.state();
    const ok = state.game === game && state.owner === owner && (state.status === 'running' || state.status === 'paused');
    return {
      ok,
      status,
      briefing: ok ? [games.session?.facts ?? '', status].filter(Boolean).join('\n\n') : status,
      state,
    };
  },
  state(): GameState {
    return games.state();
  },
};
