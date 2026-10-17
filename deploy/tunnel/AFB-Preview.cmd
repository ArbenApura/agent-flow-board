@echo off
rem Starts the agent-flow-board preview (port 5190) at logon
powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "C:\Users\Admin\Desktop\agent-flow-board\deploy\tunnel\start.ps1"
