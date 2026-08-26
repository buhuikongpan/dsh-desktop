@echo off
echo Demo: 虚拟【失败】更新进度窗（模拟 npm 报错，窗口保持打开不自动关）
cd /d "%~dp0"
npx electron demo-update.js --fail