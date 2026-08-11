@echo off
REM ---------------------------------------------------------------------------
REM Sets up the Windows build environment for the Vulkan-accelerated whisper.cpp
REM backend, then runs whatever command was passed as arguments.
REM
REM   scripts\win-build-env.bat cargo build --release
REM   scripts\win-build-env.bat tauri dev
REM
REM Why a wrapper is needed at all: ggml compiles its Vulkan shaders with
REM `vulkan-shaders-gen`, which it builds as a *nested* CMake ExternalProject.
REM When not cross-compiling, ggml passes that nested build no compiler settings
REM at all (ggml/src/ggml-vulkan/CMakeLists.txt), so the toolchain has to be
REM discoverable from the environment. Two things follow:
REM
REM   * vcvars64 must have run, so cl.exe is on PATH.
REM   * The generator must be Ninja. With the Visual Studio generator the nested
REM     configure fails with "No CMAKE_C_COMPILER could be found", because its
REM     toolset detection breaks when spawned from inside MSBuild. Ninja simply
REM     resolves cl.exe from PATH. Ninja ships inside VS Build Tools, so there is
REM     nothing extra to install.
REM
REM CMAKE_GENERATOR and the short target-dir live in src-tauri/.cargo/config.toml;
REM see that file for why each matters.
REM ---------------------------------------------------------------------------

if "%~1"=="" (
    echo [win-build-env] usage: %~nx0 ^<command^> [args...]
    exit /b 2
)

REM --- Locate Visual Studio via vswhere (works for 2019/2022/newer) -----------
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" (
    echo [win-build-env] ERROR: vswhere.exe not found. Install Visual Studio Build Tools
    echo                with the "Desktop development with C++" workload.
    exit /b 1
)

REM Routed through a temp file rather than `for /f`, which keeps the quoting of a
REM path containing spaces straightforward.
set "VSINSTALL="
set "VSWHERE_OUT=%TEMP%\whisper-scribe-vswhere.txt"
"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath > "%VSWHERE_OUT%" 2>nul
if exist "%VSWHERE_OUT%" set /p VSINSTALL=<"%VSWHERE_OUT%"
del "%VSWHERE_OUT%" >nul 2>&1
if not defined VSINSTALL (
    echo [win-build-env] ERROR: no Visual Studio install with the C++ toolset was found.
    exit /b 1
)

REM vcvars64 output goes to a log rather than the console: VS 2019's own script
REM prints a harmless "'vswhere.exe' is not recognized" to stderr on this machine
REM and still succeeds, which is just noise on every build. The log is echoed back
REM if it actually fails, so nothing is lost when it matters.
set "VCVARS_LOG=%TEMP%\whisper-scribe-vcvars.log"
call "%VSINSTALL%\VC\Auxiliary\Build\vcvars64.bat" > "%VCVARS_LOG%" 2>&1
if errorlevel 1 (
    echo [win-build-env] ERROR: vcvars64.bat failed:
    type "%VCVARS_LOG%"
    exit /b 1
)
del "%VCVARS_LOG%" >nul 2>&1

REM --- Ninja (bundled with VS) -----------------------------------------------
set "NINJA_DIR=%VSINSTALL%\Common7\IDE\CommonExtensions\Microsoft\CMake\Ninja"
if exist "%NINJA_DIR%\ninja.exe" (
    set "PATH=%NINJA_DIR%;%PATH%"
) else (
    where ninja >nul 2>&1
    if errorlevel 1 (
        echo [win-build-env] ERROR: ninja.exe not found in the VS install or on PATH.
        exit /b 1
    )
)

REM --- libclang, needed by bindgen in whisper-rs-sys -------------------------
if not defined LIBCLANG_PATH (
    if exist "%ProgramFiles%\LLVM\bin\libclang.dll" set "LIBCLANG_PATH=%ProgramFiles%\LLVM\bin"
)
if not defined LIBCLANG_PATH (
    echo [win-build-env] ERROR: LIBCLANG_PATH is not set and LLVM was not found at
    echo                "%ProgramFiles%\LLVM\bin". Install LLVM ^(winget install LLVM.LLVM^)
    echo                or set LIBCLANG_PATH yourself.
    exit /b 1
)

REM --- Vulkan SDK, required by whisper-rs-sys's build.rs ----------------------
REM The installer sets VULKAN_SDK machine-wide, but shells opened before the
REM install never see it, so fall back to probing the default location. `for /d`
REM enumerates alphabetically, so the last match is the newest version.
if not defined VULKAN_SDK (
    for /d %%d in ("%SystemDrive%\VulkanSDK\*") do (
        if exist "%%d\Include\vulkan\vulkan.h" if exist "%%d\Lib\vulkan-1.lib" set "VULKAN_SDK=%%d"
    )
)
if not defined VULKAN_SDK (
    echo [win-build-env] ERROR: the Vulkan SDK was not found. Install it with
    echo                "winget install KhronosGroup.VulkanSDK", or set VULKAN_SDK
    echo                yourself if it lives outside %SystemDrive%\VulkanSDK.
    exit /b 1
)

echo [win-build-env] VS         : %VSINSTALL%
echo [win-build-env] VULKAN_SDK : %VULKAN_SDK%
echo [win-build-env] LIBCLANG   : %LIBCLANG_PATH%

call %*
exit /b %errorlevel%
