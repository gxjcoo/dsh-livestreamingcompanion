import { describe, expect, it, vi } from 'vitest';
import {
  createWorkerDispatcher,
  type WorkerController,
} from '../src/games/minecraft/body/workerEntry';
import type {
  MinecraftActionInstruction,
  MinecraftActionResult,
  MinecraftCommand,
  MinecraftWorkerMessage,
} from '../src/games/minecraft/body/protocol';

const instruction: MinecraftActionInstruction = {
  id: 'action-1',
  name: 'dig_at',
  args: { position: { x: 1, y: 2, z: 3 } },
};

describe('Minecraft foreground action handler settlement', () => {
  it('keeps cancellation concurrent and waits for the original handler and finally cleanup', async () => {
    const handler = deferred<MinecraftActionResult>();
    const handlerStarted = deferred<void>();
    const cleanupStarted = deferred<void>();
    const cleanup = deferred<void>();
    let cleanupFinished = false;
    const controller = stubController({
      executeAction: vi.fn(async () => {
        handlerStarted.resolve();
        try {
          return await handler.promise;
        } finally {
          cleanupStarted.resolve();
          await cleanup.promise;
          cleanupFinished = true;
        }
      }),
      cancelAction: vi.fn(async () => true),
    });
    const { dispatch, messages } = dispatcher(controller);

    const executing = dispatch(command('command-action', 'execute-action', instruction));
    await handlerStarted.promise;
    await dispatch(command('command-cancel', 'cancel-action', { actionId: instruction.id }));

    expect(controller.cancelAction).toHaveBeenCalledWith(instruction.id);
    expect(settledEvents(messages)).toEqual([]);

    handler.resolve(actionResult());
    await cleanupStarted.promise;
    expect(settledEvents(messages)).toEqual([]);
    expect(messages.some((message) => message.type === 'response' && message.id === 'command-action')).toBe(false);

    cleanup.resolve();
    await executing;

    expect(cleanupFinished).toBe(true);
    expect(messages.map(messageKind)).toEqual([
      'response:command-cancel',
      'response:command-action',
      'action-handler-settled:action-1',
    ]);
    expect(settledEvents(messages)).toEqual([{ kind: 'action-handler-settled', actionId: instruction.id }]);
  });

  it('emits one lifecycle notification after a normal result without duplicating the result', async () => {
    const result = actionResult();
    const { dispatch, messages } = dispatcher(stubController({
      executeAction: vi.fn(async () => result),
    }));

    await dispatch(command('command-action', 'execute-action', instruction));

    expect(messages).toEqual([
      { type: 'response', id: 'command-action', ok: true, data: result },
      { type: 'event', event: { kind: 'action-handler-settled', actionId: instruction.id } },
    ]);
  });

  it('emits the settlement barrier after an unsafe handler failure response', async () => {
    const handler = deferred<MinecraftActionResult>();
    const handlerStarted = deferred<void>();
    const { dispatch, messages } = dispatcher(stubController({
      executeAction: vi.fn(async () => {
        handlerStarted.resolve();
        return handler.promise;
      }),
      cancelAction: vi.fn(async () => true),
    }));

    const executing = dispatch(command('command-action', 'execute-action', instruction));
    await handlerStarted.promise;
    await dispatch(command('command-cancel', 'cancel-action', { actionId: instruction.id }));
    handler.reject(new Error('unsafe reflex interruption'));
    await executing;

    expect(messages).toEqual([
      { type: 'response', id: 'command-cancel', ok: true, data: true },
      { type: 'response', id: 'command-action', ok: false, error: 'unsafe reflex interruption' },
      { type: 'event', event: { kind: 'action-handler-settled', actionId: instruction.id } },
    ]);
  });

  it('does not emit foreground settlements for quick actions or wrong/stale cancellation IDs', async () => {
    const { dispatch, messages } = dispatcher(stubController({
      quickAction: vi.fn(async () => actionResult('quick-1')),
      cancelAction: vi.fn(async () => false),
    }));

    await dispatch(command('command-quick', 'quick-action', { ...instruction, id: 'quick-1', name: 'equip' }));
    await dispatch(command('command-stale', 'cancel-action', { actionId: 'stale-action' }));

    expect(settledEvents(messages)).toEqual([]);
    expect(messages).toEqual([
      { type: 'response', id: 'command-quick', ok: true, data: actionResult('quick-1') },
      { type: 'response', id: 'command-stale', ok: true, data: false },
    ]);
  });
});

function dispatcher(controller: WorkerController): {
  dispatch: ReturnType<typeof createWorkerDispatcher>;
  messages: MinecraftWorkerMessage[];
} {
  const messages: MinecraftWorkerMessage[] = [];
  return {
    dispatch: createWorkerDispatcher(controller, (message) => messages.push(message)),
    messages,
  };
}

function stubController(overrides: Partial<WorkerController>): WorkerController {
  return overrides as unknown as WorkerController;
}

function command<T>(id: string, action: MinecraftCommand['action'], payload: T): MinecraftCommand<T> {
  return { type: 'command', id, action, payload };
}

function actionResult(actionId = instruction.id): MinecraftActionResult {
  return {
    actionId,
    outcome: 'succeeded',
    summary: 'done',
    durationMs: 1,
    inventoryDelta: {},
    worldChanges: [],
    observations: [],
  };
}

function settledEvents(messages: MinecraftWorkerMessage[]): { kind: 'action-handler-settled'; actionId: string }[] {
  return messages.flatMap((message) => message.type === 'event' && message.event.kind === 'action-handler-settled'
    ? [message.event]
    : []);
}

function messageKind(message: MinecraftWorkerMessage): string {
  return message.type === 'response'
    ? `response:${message.id}`
    : `${message.event.kind}:${'actionId' in message.event ? message.event.actionId : ''}`;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
