@echo off
REM Link the pinned DSH checkout into this package's node_modules so the plugin
REM compiles and runs against REAL DSH packages. Junctions are used because they
REM do not need elevation on Windows.
REM
REM This is a development convenience for THIS machine's layout. It is not part
REM of the deliverable: a real deployment resolves these through the profile's
REM own dependency installation.
setlocal
set SRC=D:\DSH\src\dsh-src
set DST=%~dp0node_modules\@deepseek-ai

if not exist "%DST%" mkdir "%DST%"

call :link cordis              vendor\cordis
call :link schemastery         vendor\schemastery
call :link cosmokit            vendor\cosmokit
call :link dsh-agent           packages\core\agent
call :link dsh-tools           packages\core\tools
call :link dsh-session         packages\core\session
call :link dsh-system-prompt   packages\core\system-prompt
call :link dsh-llm             packages\llm\llm
call :link dsh-jobs            packages\jobs\jobs
call :link dsh-storage         packages\storage\storage
call :link dsh-storage-domain  packages\storage\storage-domain
call :link dsh-storage-json    packages\storage\storage-json
call :link dsh-subagent        packages\subagent\subagent

echo done
exit /b 0

:link
if exist "%DST%\%~1" rmdir "%DST%\%~1" 2>nul
if exist "%SRC%\%~2" (
  mklink /J "%DST%\%~1" "%SRC%\%~2" >nul
  echo linked %~1
) else (
  echo SKIP %~1 - missing %SRC%\%~2
)
exit /b 0
