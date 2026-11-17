@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist node_modules (
  echo 第一次使用：安裝套件中，約需一分鐘……
  call npm install || goto :error
)
call npm run start:fast
if errorlevel 1 goto :error
exit /b 0
:error
echo.
echo 啟動失敗，請把上面的訊息截圖給我。
pause
