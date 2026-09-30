# Third-party notices

## pyannote.audio (code)

`vocalgraph/speakers.py` is a port of the speaker-diarization pipeline
logic from pyannote.audio 3.4 (segmentation aggregation, speaker counting,
agglomerative clustering, reconstruction), and
`tools/export_embedding.py` reproduces its masked statistics pooling.
https://github.com/pyannote/pyannote-audio

```
MIT License

Copyright (c) 2020 CNRS

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## pyannote segmentation-3.0 (model)

`vocalgraph/models/segmentation-3.0.onnx`: pyannote/segmentation-3.0,
MIT License, Copyright (c) 2022 CNRS (same terms as above). ONNX conversion
by the sherpa-onnx project (https://github.com/k2-fsa/sherpa-onnx).
https://huggingface.co/pyannote/segmentation-3.0

## WeSpeaker ResNet34-LM (model)

`vocalgraph/models/wespeaker-resnet34-LM-masked.onnx`: the WeSpeaker
ResNet34-LM speaker-embedding model trained on VoxCeleb, as packaged by
pyannote (https://huggingface.co/pyannote/wespeaker-voxceleb-resnet34-LM).
Licensed under the Creative Commons Attribution 4.0 International License
(https://creativecommons.org/licenses/by/4.0/), following its training data.

**Changes made:** re-exported from PyTorch to ONNX with the weighted statistics
pooling and final linear layer included in the graph, so it accepts per-frame
weights. The network weights are unchanged.

Please cite, as the model card asks:

- Hongji Wang, Chengdong Liang, Shuai Wang, Zhengyang Chen, Binbin Zhang,
  Xu Xiang, Yanlei Deng, Yanmin Qian. *Wespeaker: A research and production
  oriented speaker embedding learning toolkit.* ICASSP 2023.
- Hervé Bredin. *pyannote.audio 2.1 speaker diarization pipeline: principle,
  benchmark, and recipe.* Interspeech 2023.

## openSMILE (voice measurement)

Pitch, resonance, loudness and breathiness are measured with openSMILE 3
(eGeMAPSv02 low-level descriptors), installed from PyPI as the `opensmile`
package; it is not copied into this repository.
https://github.com/audeering/opensmile

Copyright (c) audEERING GmbH. Licensed under the audEERING Research License
Agreement, which permits use and distribution for non-commercial purposes only.
Commercial use, including use of the software or of features extracted with it
in a product, requires a commercial licence from audEERING GmbH. The full
terms are in the package's metadata and at
https://github.com/audeering/opensmile/blob/master/LICENSE.

Please cite, as openSMILE asks:

- Florian Eyben, Martin Wöllmer, Björn Schuller. *openSMILE - The Munich
  Versatile and Fast Open-Source Audio Feature Extractor.* Proc. ACM
  Multimedia (MM), 2010, pp. 1459-1462.
