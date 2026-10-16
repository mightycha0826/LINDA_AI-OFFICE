// pm2 설정 (3장 프로세스 관리). 죽으면 다시 띄우고, Windows 작업 스케줄러가 부팅 때 pm2를 시작한다.
//   pm2 start ecosystem.config.cjs
//   pm2 save
module.exports = {
  apps: [
    {
      name: 'ai-office',
      cwd: __dirname + '/packages/orchestrator',
      script: 'src/main.ts',
      interpreter: 'node',
      env: { AI_OFFICE_DATA: 'C:\\ai-office\\data' },
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      time: true,
    },
  ],
};
