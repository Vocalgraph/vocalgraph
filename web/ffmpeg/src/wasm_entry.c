/*
 * wasm_entry.c - run the ffmpeg CLI's main() on its own pthread.
 *
 * JavaScript calls vg_run_async(argc, argv, id) on the module's main runtime
 * thread (a dedicated worker in the browser, the main thread in Node). It
 * starts a detached pthread that runs main() and, when main() returns,
 * reports the exit code back to the main runtime thread with
 * Module.vgDone(id, code) (vg_done in library.js). The main runtime thread
 * is never blocked, so it
 * stays free to serve the file-system and stdio calls the FFmpeg threads
 * proxy to it, and to start pool workers on demand.
 *
 * main() resets the CLI's globals at its start (ffmpeg_wasm_reset() in
 * fftools/ffmpeg.c, added by ffmpeg-7.1-wasm.patch), so it can be run any
 * number of times in one instance, one run at a time.
 *
 * Part of the Vocalgraph FFmpeg wasm build; LGPL-2.1-or-later like FFmpeg.
 */
#include <errno.h>
#include <pthread.h>
#include <stdlib.h>

#include <emscripten.h>

int main(int argc, char **argv);
int vg_run_async(int argc, char **argv, int id);
/* JS (library.js): Module.vgDone(id, code), proxied asynchronously to the
 * main runtime thread. */
void vg_done(int id, int code);

typedef struct Job {
    int    argc;
    char **argv;
    int    id;
} Job;

static void *job_thread(void *arg)
{
    Job *job = arg;
    int id = job->id, ret;

    ret = main(job->argc, job->argv);
    free(job);
    vg_done(id, ret);
    return NULL;
}

/* Returns 0 once the run has started, or an errno value. */
EMSCRIPTEN_KEEPALIVE int vg_run_async(int argc, char **argv, int id)
{
    pthread_attr_t attr;
    pthread_t thread;
    Job *job = malloc(sizeof(*job));
    int err;

    if (!job)
        return ENOMEM;
    job->argc = argc;
    job->argv = argv;
    job->id   = id;

    pthread_attr_init(&attr);
    pthread_attr_setdetachstate(&attr, PTHREAD_CREATE_DETACHED);
    err = pthread_create(&thread, &attr, job_thread, job);
    pthread_attr_destroy(&attr);
    if (err)
        free(job);
    return err;
}
