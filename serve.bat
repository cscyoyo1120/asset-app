@echo off
cd /d "%~dp0"
echo http://localhost:8082 에서 앱을 엽니다. 종료하려면 이 창을 닫으세요.
start "" http://localhost:8082
npx --yes http-server -p 8082 -c-1 .
