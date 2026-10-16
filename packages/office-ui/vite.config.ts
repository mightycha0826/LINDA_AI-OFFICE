import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// 개발 중에는 화면 서버(8780)로 데이터 요청을 넘긴다. 빌드 결과는 화면 서버가 직접 낸다.
const target = process.env.SCREEN_SERVER ?? 'http://127.0.0.1:8780';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/snapshot': target,
      '/events': { target, changeOrigin: false },
      '/tickets': target,
      '/point': target,
      '/assets': target,
    },
  },
  // 화면 파일은 /ui/ 아래로 낸다 (/assets/는 캐릭터 그림 자리)
  build: { outDir: 'dist', emptyOutDir: true, assetsDir: 'ui' },
});
