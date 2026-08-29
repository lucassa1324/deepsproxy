@echo off
cd /d "C:\Users\Lucas sá\Documents\Programação\deepsproxy\deepsproxy"
start /b npm start > server.log 2>&1
echo Server started in background. Check server.log for output.
timeout /t 5