// 자원 탭의 GPU 칸: nvidia-smi로 VRAM 사용량을 읽는다. 없거나 실패하면 null (화면은 "읽지 못했어요").
// 화면이 자주 불러도 30초에 한 번만 실행한다.
import { execFile } from 'node:child_process';

export type GpuInfo = { usedMB: number; totalMB: number } | null;

export function parseNvidiaSmi(out: string): GpuInfo {
  const line = out.trim().split(/\r?\n/)[0];
  const m = line?.match(/^\s*(\d+)\s*,\s*(\d+)\s*$/);
  return m ? { usedMB: Number(m[1]), totalMB: Number(m[2]) } : null;
}

export function gpuReader(ttlMs = 30_000) {
  let cached: { at: number; value: GpuInfo } | null = null;
  return (): Promise<GpuInfo> => {
    if (cached && Date.now() - cached.at < ttlMs) return Promise.resolve(cached.value);
    return new Promise((resolve) => {
      execFile('nvidia-smi', ['--query-gpu=memory.used,memory.total', '--format=csv,noheader,nounits'], { timeout: 5000, windowsHide: true }, (err, stdout) => {
        const value = err ? null : parseNvidiaSmi(stdout);
        cached = { at: Date.now(), value };
        resolve(value);
      });
    });
  };
}
