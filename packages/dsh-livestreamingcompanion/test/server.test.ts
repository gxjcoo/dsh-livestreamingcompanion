import type { networkInterfaces } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { lanIPv4, StageServer } from '../src/body/server';
import type { Packs } from '../src/body/packs';
import type { Stage } from '../src/body/stage';

type Interfaces = ReturnType<typeof networkInterfaces>;

function ipv4(address: string, internal = false) {
  return { address, internal, family: 'IPv4', netmask: '255.255.255.0', mac: '00:00:00:00:00:00', cidr: `${address}/24` } as const;
}

const servers: StageServer[] = [];
afterEach(() => {
  while (servers.length) servers.pop()!.stop();
});

function testServer(): StageServer {
  const server = new StageServer({
    port: 0,
    token: 'test-token',
    packageDir: process.cwd(),
    packs: {} as Packs,
    stage: { said() {} } as unknown as Stage,
    current: () => ({ character: 'test', template: 'default', showTerminal: true }),
  });
  servers.push(server);
  return server;
}

describe('舞台局域网访问', () => {
  it('优先选择物理网卡的私网 IPv4，忽略回环、公网和虚拟网卡', () => {
    const interfaces: Interfaces = {
      Loopback: [ipv4('127.0.0.1', true)],
      'vEthernet (WSL)': [ipv4('172.31.128.1')],
      Public: [ipv4('8.8.8.8')],
      '以太网': [ipv4('10.22.0.147')],
    };
    expect(lanIPv4(interfaces)).toBe('10.22.0.147');
    expect(lanIPv4({ Loopback: [ipv4('127.0.0.1', true)] })).toBeNull();
  });

  it('同时接受本机和局域网地址，并继续校验 token', async () => {
    const server = testServer();
    await server.start();

    const local = new URL(server.url);
    local.pathname = '/said';
    expect((await fetch(local, { method: 'POST' })).status).toBe(204);

    local.searchParams.set('token', 'wrong');
    expect((await fetch(local, { method: 'POST' })).status).toBe(401);

    // 没有物理网卡的测试环境仍验证本机；有网卡时必须真的能通过局域网地址请求。
    if (server.lanUrl) {
      const lan = new URL(server.lanUrl);
      expect(lan.hostname).not.toBe('127.0.0.1');
      lan.pathname = '/said';
      expect((await fetch(lan, { method: 'POST' })).status).toBe(204);
    }
  });
});
