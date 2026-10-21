// 증명사진 (13장, 2026-10-21 CEO 요청): assets/portraits/<직원 ID>.(webp|png|jpg). 화면 서버가 있을 때만 스냅샷에 싣는다.
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { Snapshot } from '@ai-office/shared';
import { defaultScreenDirs, modelOf, portraitOf, screenHandler } from '../src/http/screen-server.ts';
import { setup, tempRoot } from './helpers.ts';

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

function get(port: number, path: string) {
  return new Promise<{ status: number; type: string; body: Buffer }>((ok, fail) => {
    const req = request({ host: '127.0.0.1', port, path, headers: { host: `127.0.0.1:${port}` } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (d: Buffer) => chunks.push(d));
      res.on('end', () => ok({ status: res.statusCode!, type: String(res.headers['content-type']), body: Buffer.concat(chunks) }));
    });
    req.on('error', fail);
    req.end();
  });
}

function assetsWith(files: Record<string, string>, models: Record<string, string> = {}) {
  const root = tempRoot();
  const assets = join(root, 'assets');
  mkdirSync(join(assets, 'portraits'), { recursive: true });
  mkdirSync(join(assets, 'models'), { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(assets, 'portraits', name), body);
  for (const [name, body] of Object.entries(models)) writeFileSync(join(assets, 'models', name), body);
  return { root, assets };
}

const repoAssets = () => defaultScreenDirs(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')).assetsDir;

describe('증명사진 찾기', () => {
  it('webp → png → jpg 순으로 처음 찾은 것, 없으면 null', () => {
    const { assets } = assetsWith({ 'pm.png': 'p', 'pm.webp': 'w', 'dev-a.jpg': 'j' });
    expect(portraitOf(assets, 'pm')).toBe('/assets/portraits/pm.webp');
    expect(portraitOf(assets, 'dev-a')).toBe('/assets/portraits/dev-a.jpg');
    expect(portraitOf(assets, 'reviewer')).toBeNull();
  });

  it('직원 ID가 아닌 값(경로 이동)은 찾지 않는다', () => {
    const { assets } = assetsWith({ 'pm.webp': 'w' });
    expect(portraitOf(assets, '../portraits/pm')).toBeNull();
  });

  it('이름 있는 9명 모두 사진이 저장소에 있다 (기준: Discord 봇 프로필, 2026-10-21)', () => {
    for (const id of ['chief-of-staff', 'pm', 'developer', 'marketing', 'dev-a', 'dev-b', 'strategy', 'qa-local', 'reviewer']) {
      expect(portraitOf(repoAssets(), id), id).toBe(`/assets/portraits/${id}.webp`);
    }
  });
});

describe('3D 캐릭터 모델 찾기 (13장 3D 캐릭터)', () => {
  it('assets/models/<직원 ID>.vrm이 있을 때만 주소, 경로 이동은 찾지 않는다', () => {
    const { assets } = assetsWith({}, { 'dev-a.vrm': 'glTF', 'pm.glb': 'x' });
    expect(modelOf(assets, 'dev-a')).toBe('/assets/models/dev-a.vrm');
    expect(modelOf(assets, 'pm')).toBeNull();
    expect(modelOf(assets, '../models/dev-a')).toBeNull();
  });
});

describe('화면 서버', () => {
  it('스냅샷에 사진 주소와 개인 이름을 싣고, webp를 image/webp로 보낸다', async () => {
    const s = setup();
    const { root, assets } = assetsWith({ 'chief-of-staff.webp': 'RIFF-webp' });
    const server = createServer(screenHandler({ c: s.ctx, staticDir: join(root, 'dist'), pointDir: join(root, 'point'), assetsDir: assets, extras: () => ({ startedAt: '2026-10-21T00:00:00Z', gpu: null }) }));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    servers.push(server);
    const port = (server.address() as AddressInfo).port;

    const snap = JSON.parse((await get(port, '/snapshot')).body.toString('utf8')) as Snapshot;
    const chief = snap.employees.find((e) => e.id === 'chief-of-staff')!;
    expect(chief).toMatchObject({ personalName: '백서진', portrait: '/assets/portraits/chief-of-staff.webp' });
    expect(snap.employees.find((e) => e.id === 'pm')).toMatchObject({ personalName: '류하영', portrait: null });
    expect(snap.employees.find((e) => e.id === 'git-cat')).toMatchObject({ personalName: null, portrait: null });

    const img = await get(port, chief.portrait!);
    expect(img.status).toBe(200);
    expect(img.type).toBe('image/webp');
    expect(img.body.toString()).toBe('RIFF-webp');
  });

  it('VRM이 있는 직원만 스냅샷에 model 주소를 싣고, model/gltf-binary로 보낸다', async () => {
    const s = setup();
    const { root, assets } = assetsWith({}, { 'dev-a.vrm': 'glTF-binary' });
    const server = createServer(screenHandler({ c: s.ctx, staticDir: join(root, 'dist'), pointDir: join(root, 'point'), assetsDir: assets, extras: () => ({ startedAt: '2026-10-21T00:00:00Z', gpu: null }) }));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    servers.push(server);
    const port = (server.address() as AddressInfo).port;

    const snap = JSON.parse((await get(port, '/snapshot')).body.toString('utf8')) as Snapshot;
    expect(snap.employees.find((e) => e.id === 'dev-a')!.model).toBe('/assets/models/dev-a.vrm');
    expect(snap.employees.find((e) => e.id === 'dev-b')!.model).toBeNull();
    const vrm = await get(port, '/assets/models/dev-a.vrm');
    expect(vrm.status).toBe(200);
    expect(vrm.type).toBe('model/gltf-binary');
  });
});
