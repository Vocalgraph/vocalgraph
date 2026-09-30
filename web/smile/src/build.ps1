# Paths are those of the machine this was first built on (see ../NOTICE.md).
# Links openSMILE (built with Emscripten into ..\build-wasm) and smile_shim.cpp
# into smile.mjs + smile.wasm, with the opensmile Python package's config files
# embedded at /config.
$v = "<build folder>"
. "$v\emsdk\emsdk_env.ps1" *> $null
Set-Location "$v\smile-web"
if (-not (Test-Path config)) {
  Copy-Item -Recurse "<repo folder>\.venv\Lib\site-packages\opensmile\core\config" config
}
$src = "$v\opensmile-src"
$args = @(
  '-O3', '-std=c++11', '-D__STATIC_LINK',
  "-I$src\src\include", "-I$src\progsrc\include", "-I$v\build-wasm\src\include",
  'smile_shim.cpp', "$src\progsrc\smileapi\SMILEapi.cpp", "$v\build-wasm\libopensmile.a",
  '-o', 'smile.mjs',
  '-sMODULARIZE=1', '-sEXPORT_ES6=1', '-sEXPORT_NAME=createSmile',
  '-sENVIRONMENT=web,worker,node', '-sALLOW_MEMORY_GROWTH=1',
  '-sEXPORTED_FUNCTIONS=_st_process,_st_values,_st_starts,_st_ends,_st_width,_st_num_names,_st_name,_st_error,_malloc,_free',
  '-sEXPORTED_RUNTIME_METHODS=UTF8ToString,stringToUTF8,lengthBytesUTF8,HEAPU8,HEAP16,HEAP32,HEAPF32,HEAPF64',
  '--embed-file', 'config@/config'
)
& em++ @args
"exit $LASTEXITCODE"
Get-ChildItem smile.* | Select-Object Name, Length | Format-Table | Out-String
