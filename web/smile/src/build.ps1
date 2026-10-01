# Links openSMILE and smile_shim.cpp into smile.mjs + smile.wasm (see
# ../NOTICE.md), with the opensmile Python package's config files embedded at
# /config. Before running it:
#   * build openSMILE 3.0.2 with Emscripten (emcmake cmake -G Ninja
#     -DSTATIC_LINK=ON ..., then ninja opensmile) into $env:VG_SMILE_BUILD;
#   * $env:EMSDK: the Emscripten SDK folder; $env:VG_SMILE_SRC: openSMILE's
#     source (tag v3.0.2); $env:VG_SMILE_WORK: a scratch folder to link in.
# The app's own environment (.venv, from uv sync) provides the config files.
param()
$ErrorActionPreference = 'Stop'
$repo = Resolve-Path (Join-Path $PSScriptRoot '..\..\..')
foreach ($name in 'EMSDK', 'VG_SMILE_SRC', 'VG_SMILE_BUILD', 'VG_SMILE_WORK') {
  if (-not [Environment]::GetEnvironmentVariable($name)) { throw "set `$env:$name first (see the top of this script)" }
}
. "$env:EMSDK\emsdk_env.ps1" *> $null
New-Item -ItemType Directory -Force $env:VG_SMILE_WORK | Out-Null
Set-Location $env:VG_SMILE_WORK
Copy-Item -Force (Join-Path $PSScriptRoot 'smile_shim.cpp') .
if (-not (Test-Path config)) {
  Copy-Item -Recurse (Join-Path $repo '.venv\Lib\site-packages\opensmile\core\config') config
}
$src = $env:VG_SMILE_SRC
$flags = @(
  '-O3', '-std=c++11', '-D__STATIC_LINK',
  # source paths in the binary relative, so it doesn't name the machine it was built on
  "-ffile-prefix-map=$src=.", "-ffile-prefix-map=$($env:VG_SMILE_BUILD)=.", "-ffile-prefix-map=$($env:EMSDK)=.",
  "-I$src\src\include", "-I$src\progsrc\include", "-I$($env:VG_SMILE_BUILD)\src\include",
  'smile_shim.cpp', "$src\progsrc\smileapi\SMILEapi.cpp", "$($env:VG_SMILE_BUILD)\libopensmile.a",
  '-o', 'smile.mjs',
  '-sMODULARIZE=1', '-sEXPORT_ES6=1', '-sEXPORT_NAME=createSmile',
  '-sENVIRONMENT=web,worker,node', '-sALLOW_MEMORY_GROWTH=1',
  '-sEXPORTED_FUNCTIONS=_st_process,_st_values,_st_starts,_st_ends,_st_width,_st_num_names,_st_name,_st_error,_malloc,_free',
  '-sEXPORTED_RUNTIME_METHODS=UTF8ToString,stringToUTF8,lengthBytesUTF8,HEAPU8,HEAP16,HEAP32,HEAPF32,HEAPF64',
  '--embed-file', 'config@/config'
)
& em++ @flags
if ($LASTEXITCODE) { throw "em++ failed ($LASTEXITCODE)" }
Copy-Item -Force smile.mjs, smile.wasm (Join-Path $PSScriptRoot '..')
Get-ChildItem smile.* | Select-Object Name, Length | Format-Table | Out-String
