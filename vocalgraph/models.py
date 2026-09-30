"""The two speaker models, shipped with the app and checked by SHA-256.

  segmentation  pyannote segmentation-3.0 (MIT, (c) 2022 CNRS), ONNX export
                by the sherpa-onnx project. Verified against the PyTorch model:
                max output difference 2e-5, identical frame decisions.
  embedding     WeSpeaker ResNet34-LM trained on VoxCeleb (CC BY 4.0), as
                packaged by pyannote. Re-exported to ONNX by
                tools/export_embedding.py with pyannote's masked statistics
                pooling built in; voiceprints match PyTorch at cosine 1.000000.

See THIRD_PARTY_NOTICES.md for licences and attribution.
"""
from __future__ import annotations

import hashlib
import os

DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "models")

MODELS = {
    "segmentation": ("segmentation-3.0.onnx",
                     "220ad67ca923bef2fa91f2390c786097bf305bceb5e261d4af67b38e938e1079"),
    "embedding": ("wespeaker-resnet34-LM-masked.onnx",
                  "3b10b88c69ed56c07fd9ffb1b5766b32d0e5358ef2743feb4bf52e298d6d0c96"),
}
_checked: set[str] = set()


def path(name: str) -> str:
    file, digest = MODELS[name]
    p = os.path.join(DIR, file)
    if name not in _checked:
        try:
            with open(p, "rb") as fh:
                ok = hashlib.sha256(fh.read()).hexdigest() == digest
        except OSError:
            ok = False
        if not ok:
            raise RuntimeError(f"The {name} model is missing or damaged. "
                               "Download Vocalgraph again and replace this folder.")
        _checked.add(name)
    return p
