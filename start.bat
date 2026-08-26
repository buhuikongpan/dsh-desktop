@echo off
echo Starting DSH Desktop Shell...
cd /d "%~dp0"
if not exist "node_modules" (
    echo First run - installing dependencies...
    call npm install
)
npx electron .
