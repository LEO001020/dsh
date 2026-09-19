@echo off
REM Link the pinned DSH checkout into this package's node_modules so the plugin
REM compiles and runs against REAL DSH packages. Junctions are used because they
REM do not need elevation on Windows.
REM
REM This is a development convenience for THIS machine's layout. It is not part
REM of the deliverable: a real deployment resolves these through the profile's
REM own dependency installation.
setlocal
REM Resolve the checkout without hardcoding a drive letter.
REM
REM This layout has the DSH install root containing both the source checkout and
REM the working repo:  <install>\src\dsh-src  and  <install>\work\<repo>.
REM Moving the install (as happened once: D:\DSH -> D:\Code\DSH) must not leave
REM every junction pointing at a path that no longer exists, so the script walks
REM up to the install root and requires a real package.json before linking.
REM
REM DSH_SRC overrides the derivation for a checkout kept anywhere else.
REM
REM `if exist` does NOT normalize a path containing `..`, so the install root is
REM materialised with a pushd/popd round trip first. Checking the unnormalised
REM path silently reports "missing" for a checkout that is actually there.
REM
REM Depth: %~dp0 is <install>\work\<repo>\packages\dsh-daily-work\, so the repo is
REM two levels up and the INSTALL root is two more (the repo sits under <install>\work).
set REPO=%~dp0..\..
pushd "%REPO%\..\.."
set INSTALL=%CD%
popd
set SRC=%DSH_SRC%
if "%SRC%"=="" set SRC=%INSTALL%\src\dsh-src
set DST=%~dp0node_modules\@deepseek-ai

if not exist "%SRC%\package.json" (
  echo ERROR: no DSH checkout at "%SRC%"
  echo Set DSH_SRC to the pinned checkout and re-run.
  exit /b 1
)
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
