@echo off
setlocal EnableExtensions DisableDelayedExpansion
cd /d "%~dp0"
if errorlevel 1 goto :failed

set "repo_url=https://github.com/AslamGeek/medic-rep.git"
set "app_url=https://medic-rep.vercel.app/"

git rev-parse --is-inside-work-tree >nul 2>&1
if errorlevel 1 (
  echo This shortcut is not inside a Git repository.
  pause
  exit /b 1
)

set "current_branch="
for /f "delims=" %%B in ('git symbolic-ref --quiet --short HEAD 2^>nul') do set "current_branch=%%B"
if not defined current_branch (
  echo Could not determine the current branch. Check that HEAD is attached to a branch.
  pause
  exit /b 1
)
if not "%current_branch%"=="main" (
  echo Current branch: "%current_branch%"
  echo Switch to the main branch before running this shortcut.
  pause
  exit /b 1
)

git remote get-url origin >nul 2>&1
if errorlevel 1 (
  git remote add origin "%repo_url%"
) else (
  git remote set-url origin "%repo_url%"
)
if errorlevel 1 goto :failed

echo Repository: %repo_url%
git status --short
if errorlevel 1 goto :failed
echo.

git add --all
if errorlevel 1 goto :failed

git diff --cached --quiet
if errorlevel 2 goto :failed
if not errorlevel 1 (
  echo No new file changes. Checking for commits that still need pushing.
  goto :push
)

git commit -m "Update MedRep app"
if errorlevel 1 goto :failed

:push
git push --set-upstream origin main
if errorlevel 1 goto :failed

echo.
echo Push completed successfully.
echo App: %app_url%
echo Check Vercel for deployment progress.
exit /b 0

:failed
echo.
echo Commit or push failed. Your local changes and commits have been kept.
echo Review the message above. After resolving the issue, run this shortcut again.
pause
exit /b 1
