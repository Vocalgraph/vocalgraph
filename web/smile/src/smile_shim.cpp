// A small C interface over openSMILE's SMILEapi for the browser build: one
// call runs a config on 16-bit mono audio and keeps every frame, so the page
// reads the results back as plain arrays. It does what the opensmile Python
// package's Smile.process_signal does (same call order, same options).
//
// Part of a derivative build of openSMILE (audEERING Research License): this
// file is new; openSMILE itself is compiled unmodified.

#include <smileapi/SMILEapi.h>

#include <cstring>
#include <string>
#include <vector>

struct sExternalSinkMetaDataEx {   // as in src/include/iocore/externalSink.hpp
  long vIdx;
  double time;
  double period;
  double lengthSec;
};

namespace {
std::vector<float> values;       // frames x width, row by row
std::vector<double> starts, ends;
std::vector<std::string> names;
long width = 0;
std::string error;

bool on_frame(const float *data, long nT, long N, const sExternalSinkMetaDataEx *meta, void *) {
  // Same as the Python package: one row per call, stamped with the call's time.
  width = N;
  values.insert(values.end(), data, data + nT * N);
  for (long t = 0; t < nT; t++) {
    starts.push_back(meta->time);
    ends.push_back(meta->time + meta->lengthSec);
  }
  return true;
}
}  // namespace

extern "C" {

// Runs `config` with `nopt` name/value options on `n` samples of 16-bit audio.
// Returns the number of frames, or -1 (see st_error).
int st_process(const char *config, int nopt, const char **optNames, const char **optValues,
               const short *pcm, int n, int loglevel) {
  values.clear(); starts.clear(); ends.clear(); names.clear(); width = 0; error.clear();
  std::vector<smileopt_t> opts(nopt);
  for (int i = 0; i < nopt; i++) opts[i] = {optNames[i], optValues[i]};
  smileobj_t *s = smile_new();
  if (!s) { error = "smile_new failed"; return -1; }
  auto fail = [&]() { const char *m = smile_error_msg(s); error = m ? m : "unknown openSMILE error"; smile_free(s); return -1; };
  if (smile_initialize(s, config, nopt, opts.data(), loglevel, 0, 0, nullptr) != SMILE_SUCCESS) return fail();
  long count = 0;
  if (smile_extsink_get_num_elements(s, "extsink", &count) == SMILE_SUCCESS)
    for (long i = 0; i < count; i++) {
      const char *name = nullptr;
      if (smile_extsink_get_element_name(s, "extsink", i, &name) == SMILE_SUCCESS && name) names.push_back(name);
    }
  if (smile_extsink_set_data_callback_ex(s, "extsink", on_frame, nullptr) != SMILE_SUCCESS) return fail();
  if (smile_extaudiosource_write_data(s, "extsource", pcm, n * (int)sizeof(short)) != SMILE_SUCCESS) return fail();
  if (smile_extaudiosource_set_external_eoi(s, "extsource") != SMILE_SUCCESS) return fail();
  if (smile_run(s) != SMILE_SUCCESS) return fail();
  smile_free(s);
  return (int)starts.size();
}

const float *st_values() { return values.data(); }
const double *st_starts() { return starts.data(); }
const double *st_ends() { return ends.data(); }
int st_width() { return (int)width; }
int st_num_names() { return (int)names.size(); }
const char *st_name(int i) { return i >= 0 && i < (int)names.size() ? names[i].c_str() : ""; }
const char *st_error() { return error.c_str(); }

}  // extern "C"
