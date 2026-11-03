/**
 * 弹幕投票：主播列出互相冲突的做法，观众在 10 秒内发编号选择。
 * 票数由身体统计，舞台只展示；工具等同一个 Promise，结果直接交回这一轮的主播去执行。
 */

import { randomUUID } from 'node:crypto';
import type { LiveEvent } from '../core/live';
import type { VoteSnapshot } from '../stage/protocol';
import { Stage } from './stage';

export const VOTE_DURATION_MS = 10_000;
const RESULT_VISIBLE_MS = 4000;
const MAX_OPTIONS = 6;

export type VoteOutcome = 'winner' | 'tie' | 'empty' | 'cancelled';
export interface VoteResult {
  outcome: VoteOutcome;
  vote: VoteSnapshot;
}

interface ActiveVote {
  snapshot: VoteSnapshot;
  /** platform:user → 选项编号（从 1 开始）；同一个人再发有效编号就是改票 */
  ballots: Map<string, number>;
  timer: NodeJS.Timeout;
  resolve(result: VoteResult): void;
}

/**
 * 只把整条都是投票编号的弹幕当票，避免「我有 3 只猫」这种普通聊天误计票。
 * 接受 1、选 1、投 1 票、1 号，以及对应的全角数字。
 */
export function ballotOption(text: string, optionCount: number): number | null {
  const normalized = text.trim().replace(/[０-９]/g, (digit) => String(digit.charCodeAt(0) - 0xff10));
  const match = /^(?:选项|选|投)?\s*([1-9])\s*(?:号|选项|票)?\s*[。.!！~～]*$/.exec(normalized);
  if (!match) return null;
  const option = Number(match[1]);
  return option >= 1 && option <= optionCount ? option : null;
}

/** 给主播的工具结果：唯一胜选项必须接着做，其他结果不能擅自挑一个做 */
export function voteResultText(result: VoteResult): string {
  const { vote } = result;
  const counts = vote.options.map((label, i) => `${i + 1} 号「${label}」${vote.counts[i] ?? 0} 票`).join('；');
  if (result.outcome === 'cancelled') return '投票因直播结束或插件重载而取消。不要执行任何一个候选要求。';
  if (result.outcome === 'empty') return `投票结束，没有收到有效编号弹幕（${counts}）。不要执行任何一个候选要求，简短告诉观众本轮无人投票。`;
  if (result.outcome === 'tie') {
    const tied = vote.tied.map((option) => `${option} 号「${vote.options[option - 1]}」`).join('、');
    return `投票结束，${tied} 平票（${counts}）。没有唯一胜选项，不要自行挑选或执行，简短公布平票结果。`;
  }
  const winner = vote.winner!;
  return [
    `投票结束：${winner} 号「${vote.options[winner - 1]}」以 ${vote.counts[winner - 1]} 票胜出。计票：${counts}。`,
    `现在只执行 ${winner} 号「${vote.options[winner - 1]}」，不要同时执行其他选项。先用一句短话公布结果，再调用完成这件事需要的工具或直接完成它。`,
  ].join('\n');
}

export class LiveVote {
  private active: ActiveVote | null = null;
  private clearTimer: NodeJS.Timeout | null = null;

  constructor(private readonly stage: Stage) {}

  /** 开始并等待计票完成；durationMs 只供测试缩短，直播工具固定用 10 秒 */
  start(question: string, options: string[], durationMs = VOTE_DURATION_MS): Promise<VoteResult> {
    if (this.active) throw new Error('上一场投票还没结束。');
    const cleanQuestion = question.trim().replace(/\s+/g, ' ');
    const cleanOptions = options.map((option) => option.trim().replace(/\s+/g, ' '));
    if (!cleanQuestion) throw new Error('投票问题是空的。');
    if ([...cleanQuestion].length > 60) throw new Error('投票问题太长了，请缩到 60 字以内。');
    if (cleanOptions.length < 2 || cleanOptions.length > MAX_OPTIONS) throw new Error(`请提供 2–${MAX_OPTIONS} 个选项。`);
    if (cleanOptions.some((option) => !option)) throw new Error('候选做法里有空选项。');
    if (cleanOptions.some((option) => [...option].length > 40)) throw new Error('每个候选做法请控制在 40 字以内。');
    if (new Set(cleanOptions).size !== cleanOptions.length) throw new Error('候选做法有重复，请合并后再投票。');

    if (this.clearTimer) clearTimeout(this.clearTimer);
    this.clearTimer = null;
    const now = Date.now();
    const id = randomUUID();
    return new Promise<VoteResult>((resolve) => {
      const snapshot: VoteSnapshot = {
        id, question: cleanQuestion, options: cleanOptions, counts: cleanOptions.map(() => 0),
        startedAt: now, endsAt: now + durationMs, status: 'active', winner: null, tied: [],
      };
      const timer = setTimeout(() => this.finish(id), durationMs);
      this.active = { snapshot, ballots: new Map(), timer, resolve };
      this.stage.broadcast({ type: 'vote', vote: snapshot });
    });
  }

  /**
   * 喂进一条直播间事件；返回 true 表示它是本轮有效选票。
   * 调用方仍把它显示在弹幕区，但不再当普通请求推给主播或写进观众记忆。
   */
  observe(event: LiveEvent, isUpdate = false): boolean {
    const active = this.active;
    if (!active || isUpdate || event.kind !== 'chat') return false;
    const option = ballotOption(event.text, active.snapshot.options.length);
    if (option === null) return false;
    const identity = event.user.id || (event.user.name ? `name:${event.user.name}` : event.id);
    const voter = `${event.platform}:${identity}`;
    const previous = active.ballots.get(voter);
    if (previous === option) return true;
    const counts = active.snapshot.counts.slice();
    if (previous) counts[previous - 1] -= 1;
    counts[option - 1] += 1;
    active.ballots.set(voter, option);
    active.snapshot = { ...active.snapshot, counts };
    this.stage.broadcast({ type: 'vote', vote: active.snapshot });
    return true;
  }

  /** 下播或插件重载：撤销弹窗，并唤醒还在等结果的工具 */
  cancel(): void {
    if (this.clearTimer) clearTimeout(this.clearTimer);
    this.clearTimer = null;
    const active = this.active;
    this.active = null;
    this.stage.broadcast({ type: 'vote', vote: null });
    if (!active) return;
    clearTimeout(active.timer);
    active.resolve({
      outcome: 'cancelled',
      vote: { ...active.snapshot, status: 'ended', winner: null, tied: [] },
    });
  }

  private finish(id: string): void {
    const active = this.active;
    if (!active || active.snapshot.id !== id) return;
    this.active = null;
    const counts = active.snapshot.counts;
    const total = active.ballots.size;
    const highest = Math.max(...counts);
    const leaders = counts.flatMap((count, i) => (highest > 0 && count === highest ? [i + 1] : []));
    const outcome: VoteOutcome = total === 0 ? 'empty' : leaders.length > 1 ? 'tie' : 'winner';
    const vote: VoteSnapshot = {
      ...active.snapshot, counts, status: 'ended',
      winner: outcome === 'winner' ? leaders[0] : null,
      tied: outcome === 'tie' ? leaders : [],
    };
    this.stage.broadcast({ type: 'vote', vote });
    active.resolve({ outcome, vote });
    this.clearTimer = setTimeout(() => {
      this.clearTimer = null;
      this.stage.broadcast({ type: 'vote', vote: null });
    }, RESULT_VISIBLE_MS);
  }
}
