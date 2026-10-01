// --post-js for ffmpeg.mjs: lets ffmpeg.js size the pthread pool up front, so
// a command never waits for a worker to start mid-run. Workers return to
// the pool when their thread ends and are reused by later commands.
Module['vgPool'] = () => ({
  unused: PThread.unusedWorkers.length,
  running: Object.keys(PThread.pthreads).length,
});
Module['vgGrowPool'] = async (unused) => {
  const loading = [];
  while (PThread.unusedWorkers.length < unused) {
    loading.push(PThread.loadWasmModuleToWorker(PThread.allocateUnusedWorker()));
  }
  await Promise.all(loading);
};
