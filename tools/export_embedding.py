"""Export pyannote's WeSpeaker ResNet34 embedding model to ONNX, WITH mask weights.

Developer tool, run once; not shipped to users. Needs a Python environment with
pyannote.audio 3.x and PyTorch (the laptop pipeline's .venv-diarize works).

The published ONNX of this model takes features only. pyannote's diarization
pipeline also passes per-frame weights, so each local speaker's voiceprint is
pooled over only the frames where that speaker (alone) is talking. This export
keeps the network unchanged and puts that weighted statistics pooling
(pyannote.audio.models.blocks.pooling._pool) and the final linear layer into
the graph, so the app reproduces the pipeline exactly without PyTorch.

    python export_embedding.py OUT.onnx
Inputs:  fbank (batch, frames, 80), weights (batch, pooled_frames)
Output:  embedding (batch, 256)
pooled_frames = ceil(ceil(ceil(frames / 2) / 2) / 2), the ResNet's time stride.
"""
import sys

import torch
from torch import nn


class Masked(nn.Module):
    def __init__(self, resnet):
        super().__init__()
        self.r = resnet

    def forward(self, fbank, weights):
        out = self.r.forward_frames(fbank)                 # (B, C, F, T')
        b, c, f, t = out.shape
        seq = out.reshape(b, c * f, t)                      # "b d c f -> b (d c) f"
        w = weights.unsqueeze(1)
        v1 = w.sum(dim=2) + 1e-8
        mean = torch.sum(seq * w, dim=2) / v1
        dx2 = torch.square(seq - mean.unsqueeze(2))
        v2 = torch.square(w).sum(dim=2)
        var = torch.sum(dx2 * w, dim=2) / (v1 - v2 / v1 + 1e-8)
        stats = torch.cat([mean, torch.sqrt(var)], dim=1)
        return self.r.seg_1(stats)


def main(out_path: str) -> None:
    import diarize  # the laptop pipeline module: applies its torchaudio shims
    diarize.patch_torchaudio_backends()
    import pyannote.audio.core.task as t
    from pyannote.audio import Model
    torch.serialization.add_safe_globals(
        [torch.torch_version.TorchVersion, t.Specifications, t.Problem, t.Resolution])

    model = Model.from_pretrained("pyannote/wespeaker-voxceleb-resnet34-LM").eval()
    wrapped = Masked(model.resnet).eval()
    fbank = torch.randn(2, 998, 80)
    weights = torch.rand(2, 125)
    torch.onnx.export(
        wrapped, (fbank, weights), out_path, dynamo=False, opset_version=17,
        input_names=["fbank", "weights"], output_names=["embedding"],
        dynamic_axes={"fbank": {0: "batch", 1: "frames"},
                      "weights": {0: "batch", 1: "pooled_frames"},
                      "embedding": {0: "batch"}})
    print("exported", out_path)


if __name__ == "__main__":
    main(sys.argv[1])
