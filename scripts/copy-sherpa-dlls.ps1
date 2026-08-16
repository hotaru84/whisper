# Copies the sherpa-onnx shared-library DLLs into src-tauri/resources/bin/ so
# tauri.conf.json's bundle.resources can ship them next to the installed exe.
#
# Why this exists: sherpa-onnx is linked as a `shared` dependency (see the
# comment on the Cargo.toml entry for why -- this machine's linker can't
# satisfy the default `static` build). sherpa-onnx-sys's own build script
# copies its DLLs next to the compiled binary in the Cargo target directory,
# which is enough for `cargo run`/`tauri dev`, but NSIS only bundles what
# `bundle.resources` names explicitly. Without this step the installer omits
# the DLLs entirely and the installed exe fails to start.
#
# Destination has to be resources/bin -- flat, next to the exe -- not nested
# under resources/models/ like the ONNX models: Windows' DLL search order does
# not descend into subdirectories, only the exe's own directory and PATH.
#
# Runs via tauri.conf.json's build.beforeBundleCommand, which Tauri fires
# after the Rust binary is compiled (so these DLLs already exist) and before
# the bundler reads bundle.resources (so this copy lands in time to be seen).
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$manifestPath = Join-Path $repoRoot "src-tauri/Cargo.toml"
$metadata = cargo metadata --manifest-path $manifestPath --format-version 1 --no-deps | ConvertFrom-Json
$releaseDir = Join-Path $metadata.target_directory "release"
$destDir = Join-Path $repoRoot "src-tauri/resources/bin"
New-Item -ItemType Directory -Force $destDir | Out-Null

$dlls = @(
    "sherpa-onnx-c-api.dll",
    "sherpa-onnx-cxx-api.dll",
    "onnxruntime.dll",
    "onnxruntime_providers_shared.dll"
)
foreach ($dll in $dlls) {
    $src = Join-Path $releaseDir $dll
    if (-not (Test-Path $src)) {
        throw "[copy-sherpa-dlls] $dll not found in $releaseDir -- expected sherpa-onnx-sys's build script to have placed it there. Was the release build actually run with the 'shared' feature?"
    }
    Copy-Item $src (Join-Path $destDir $dll) -Force
}

# DirectML.dll only exists in $releaseDir when the build was pointed at a
# sherpa-onnx built from source with -DSHERPA_ONNX_ENABLE_DIRECTML=ON (via the
# SHERPA_ONNX_LIB_DIR env var -- see win-build-env.bat and README). Optional,
# not required: without it, diarization/audio-tagging's "directml" provider
# request just falls back to CPU inside sherpa-onnx itself (see the comment on
# `provider` in diarize.rs), so a normal build without a DirectML-enabled
# sherpa-onnx must not fail here.
$directmlDll = Join-Path $releaseDir "DirectML.dll"
if (Test-Path $directmlDll) {
    Copy-Item $directmlDll (Join-Path $destDir "DirectML.dll") -Force
    Write-Host "[copy-sherpa-dlls] copied DirectML.dll to $destDir"
}

Write-Host "[copy-sherpa-dlls] copied $($dlls.Count) DLLs to $destDir"
