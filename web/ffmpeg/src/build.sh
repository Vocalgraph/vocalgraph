#!/usr/bin/env bash
# Build FFmpeg 7.1 (the ffmpeg CLI, audio only, LGPL, multi-threaded) + LAME
# 3.100 to WebAssembly for Vocalgraph's browser version.
#
# Built with (set B and EMSDK to your folders):
#   Windows 11, Git for Windows bash (MSYS2 runtime 3.6.9)
#   Emscripten 6.0.10 (EMSDK: the emsdk folder)
#   GNU Make 4.4.1 from MSYS2 (repo.msys2.org/msys/x86_64/make-4.4.1-2-x86_64.pkg.tar.zst,
#     unpacked into $B/make-pkg; Git for Windows ships no make)
#   FFmpeg: git tag n7.1 (commit b08d7969c550a804a59511c7b83f2dd8cc0499b8)
#     from https://github.com/FFmpeg/FFmpeg (mirror of https://git.ffmpeg.org/ffmpeg.git)
#   LAME 3.100: https://downloads.sourceforge.net/project/lame/lame/3.100/lame-3.100.tar.gz
#     sha256 ddfe36cab873794038ae2c1210557ad34857a4b6bdc515785d1da9e175b1da1e
#
# Usage (from Git Bash):   bash web/ffmpeg/src/build.sh
#   RECONFIGURE=1 forces FFmpeg's configure to run again.
# Output: web/ffmpeg/ffmpeg.mjs + ffmpeg.wasm
#
# The build uses wasm threads (-pthread, SharedArrayBuffer): the page must be
# cross-origin isolated. ffmpeg-7.1-wasm.patch makes the CLI's main()
# re-runnable (it resets fftools' globals and the library settings options
# change at the start of each run); wasm_entry.c runs main() on a pthread so
# the calling (worker) thread is never blocked; post.js lets ffmpeg.js grow
# the worker pool before a run; library.js reports the end of a run to JS.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$(cd "$HERE/.." && pwd)"                       # web/ffmpeg
B="${B:-${TMPDIR:-/tmp}/vocalgraph-ffmpeg-build}"   # build scratch, outside the repo
EMSDK="${EMSDK:?set EMSDK to the emsdk folder}"
# Source paths compiled into the binary (asserts, logs) are made relative to
# $B, so the published .wasm doesn't name the machine or user that built it.
NOPATH=""
for d in "$B" "$EMSDK"; do
  NOPATH="$NOPATH -ffile-prefix-map=$d=."
  if command -v cygpath >/dev/null; then NOPATH="$NOPATH -ffile-prefix-map=$(cygpath -m "$d")=."; fi   # C:/... as the compiler sees it
done
JOBS="${JOBS:-$(nproc)}"
PREFIX="$B/prefix-mt"
SRC="$B/ffmpeg-src"
BUILD="$B/ffmpeg-obj-mt"

export EM_CONFIG="$EMSDK/.emscripten"
export PATH="$EMSDK/upstream/emscripten:$EMSDK/upstream/bin:$B/make-pkg/usr/bin:$PATH"
command -v emcc >/dev/null && command -v make >/dev/null
emcc --version | head -1

mkdir -p "$B" "$PREFIX" "$B/tmp"
export TMPDIR="$B/tmp" TMP="$B/tmp" TEMP="$B/tmp"   # configure needs a POSIX path
cd "$B"

# ---- sources ---------------------------------------------------------------
if [ ! -d "$SRC/.git" ]; then
  git -c core.autocrlf=false -c advice.detachedHead=false \
    clone --depth 1 -b n7.1 https://github.com/FFmpeg/FFmpeg.git "$SRC"
fi
( cd "$SRC"
  test "$(git rev-parse HEAD)" = b08d7969c550a804a59511c7b83f2dd8cc0499b8
  # Re-apply only when the patch changed, so make doesn't rebuild everything.
  if ! cmp -s "$HERE/ffmpeg-7.1-wasm.patch" .applied.patch; then
    git checkout -q -- . && git clean -qfd
    git apply "$HERE/ffmpeg-7.1-wasm.patch"
    cp "$HERE/ffmpeg-7.1-wasm.patch" .applied.patch
  fi
  cmp -s "$HERE/wasm_entry.c" fftools/wasm_entry.c || cp "$HERE/wasm_entry.c" fftools/ )

if [ ! -f lame-3.100.tar.gz ]; then
  curl -sSL -o lame-3.100.tar.gz \
    https://downloads.sourceforge.net/project/lame/lame/3.100/lame-3.100.tar.gz
fi
echo "ddfe36cab873794038ae2c1210557ad34857a4b6bdc515785d1da9e175b1da1e  lame-3.100.tar.gz" | sha256sum -c -

# ---- LAME 3.100 (LGPL) -----------------------------------------------------
if [ ! -f "$PREFIX/lib/libmp3lame.a" ]; then
  rm -rf lame-3.100-mt && mkdir lame-3.100-mt
  tar xzf lame-3.100.tar.gz -C lame-3.100-mt --strip-components=1
  ( cd lame-3.100-mt
    CC=emcc LD=emcc AR=emar RANLIB=emranlib NM=emnm CFLAGS="-O3 -pthread $NOPATH" \
      bash ./configure --prefix="$PREFIX" --host=i686-linux \
        --disable-shared --enable-static --disable-frontend --disable-decoder \
        --disable-analyzer-hooks --disable-dependency-tracking --disable-gtktest
    make -j"$JOBS" && make install )
fi

# ---- FFmpeg 7.1 ------------------------------------------------------------
CONF_FLAGS=(
  --prefix="$PREFIX"
  --target-os=none --arch=x86_32 --enable-cross-compile
  --cc=emcc --cxx=em++ --ld=emcc --ar=emar --ranlib=emranlib --nm=emnm
  --dep-cc=emcc --host-cc=emcc     # host tools are not built (no hardcoded tables)
  --extra-cflags="-O3 -pthread $NOPATH -I$PREFIX/include"
  --extra-ldflags="-pthread -L$PREFIX/lib"
  --optflags="-O3"
  --disable-asm --disable-inline-asm --disable-x86asm
  --disable-runtime-cpudetect --disable-autodetect --disable-stripping
  --disable-debug --disable-doc --disable-network
  --enable-pthreads --disable-w32threads --disable-os2threads
  --disable-programs --enable-ffmpeg
  --disable-avdevice --disable-swscale --disable-postproc
  --disable-everything
  --enable-protocol=file,pipe
  --enable-demuxer=mov,matroska,mp3,wav,flac,ogg,aac,w64,aiff,caf,asf,pcm_s16le,pcm_f32le
  --enable-decoder=mp3,mp3float,aac,aac_latm,alac,flac,opus,vorbis,wmav2
  --enable-decoder=pcm_s16le,pcm_s24le,pcm_s32le,pcm_f32le,pcm_f64le,pcm_s16be,pcm_s24be,pcm_s32be,pcm_f32be,pcm_u8,pcm_mulaw,pcm_alaw
  --enable-encoder=aac,flac,pcm_s16le,pcm_f32le,libmp3lame,opus
  --enable-muxer=ipod,mp4,mov,matroska,webm,mp3,wav,flac,adts,ogg,opus,pcm_f32le,pcm_s16le,null
  --enable-parser=aac,mpegaudio,flac,opus,vorbis
  --enable-filter=abuffer,abuffersink,aresample,aformat,anull,atrim,asetpts,concat,amix,amerge,asplit,pan,adelay,volume,apad,aevalsrc,anullsrc
  --enable-libmp3lame
)

if [ ! -f "$BUILD/ffbuild/config.mak" ] || [ "${RECONFIGURE:-0}" = 1 ]; then
  rm -rf "$BUILD" && mkdir -p "$BUILD"
  ( cd "$BUILD" && bash "$SRC/configure" "${CONF_FLAGS[@]}" )
  # configure records its command line and data folder in config.h, which end
  # up in the binary (ffmpeg -buildconf): show the build folders as "." there.
  for d in "$B" "$EMSDK"; do
    sed -i "s#$d#.#g" "$BUILD/config.h"
    if command -v cygpath >/dev/null; then sed -i "s#$(cygpath -m "$d")#.#g" "$BUILD/config.h"; fi
  done
fi
FFTOOLS_OBJS="fftools/cmdutils.o fftools/opt_common.o fftools/ffmpeg.o fftools/ffmpeg_dec.o
  fftools/ffmpeg_demux.o fftools/ffmpeg_enc.o fftools/ffmpeg_filter.o fftools/ffmpeg_hw.o
  fftools/ffmpeg_mux.o fftools/ffmpeg_mux_init.o fftools/ffmpeg_opt.o fftools/ffmpeg_sched.o
  fftools/objpool.o fftools/sync_queue.o fftools/thread_queue.o fftools/wasm_entry.o"
LIBS="libavfilter/libavfilter.a libavformat/libavformat.a libavcodec/libavcodec.a
  libswresample/libswresample.a libavutil/libavutil.a"
cd "$BUILD"
make -j"$JOBS" $LIBS $FFTOOLS_OBJS

# ---- link ------------------------------------------------------------------
# PTHREAD_POOL_SIZE: workers started with the module. A plain decode uses 6
# threads (main + demuxer, decoder, filtergraph, encoder, muxer); ffmpeg.js
# grows the pool before bigger commands (vgGrowPool), and the pool is kept
# for later commands.
emcc -O3 -pthread -o "$OUT/ffmpeg.mjs" $FFTOOLS_OBJS $LIBS \
  -L"$PREFIX/lib" -lmp3lame -lm \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createFFmpeg \
  -sENVIRONMENT=web,worker,node \
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=64MB -sMAXIMUM_MEMORY=4GB \
  -sSTACK_SIZE=2MB -sDEFAULT_PTHREAD_STACK_SIZE=2MB \
  -sPTHREAD_POOL_SIZE=8 \
  -sINVOKE_RUN=0 -sEXIT_RUNTIME=0 -sFORCE_FILESYSTEM=1 \
  -sEXPORTED_FUNCTIONS=_vg_run_async,_malloc,_free \
  -sEXPORTED_RUNTIME_METHODS=FS,stringToNewUTF8,setValue \
  --post-js "$HERE/post.js" --js-library "$HERE/library.js" \
  ${EXTRA_LDFLAGS:-}

ls -la "$OUT/ffmpeg.mjs" "$OUT/ffmpeg.wasm"
