"""Kaldi-compatible log-mel filterbank, in numpy.

Reproduces what pyannote's WeSpeaker model computes before the network
(torchaudio.compliance.kaldi.fbank, as configured by
pyannote.audio.models.embedding.wespeaker): input scaled to 16-bit range,
80 mel bins, 25 ms Hamming frames every 10 ms, no dither, DC offset removed,
0.97 pre-emphasis, 512-point power spectrum, log floored at float32 eps, then
the mean over time subtracted. Verified against torchaudio on real audio.
"""
from __future__ import annotations

import numpy as np

RATE = 16000
WIN, HOP, NFFT, BINS = 400, 160, 512, 80
EPS = np.finfo(np.float32).eps


def _mel(f):
    return 1127.0 * np.log(1.0 + f / 700.0)


def _mel_banks() -> np.ndarray:
    """(NFFT // 2 + 1, BINS) triangular filters in the mel domain, Kaldi style."""
    nyquist = RATE / 2
    mel_low, mel_high = _mel(20.0), _mel(nyquist)
    delta = (mel_high - mel_low) / (BINS + 1)
    b = np.arange(BINS)[:, None]
    left, center, right = mel_low + b * delta, mel_low + (b + 1) * delta, mel_low + (b + 2) * delta
    mel = _mel((RATE / NFFT) * np.arange(NFFT // 2))[None, :]
    banks = np.maximum(0.0, np.minimum((mel - left) / (center - left), (right - mel) / (right - center)))
    return np.pad(banks, ((0, 0), (0, 1))).T.astype(np.float32)   # Nyquist bin gets no weight


_BANKS = _mel_banks()
_WINDOW = (0.54 - 0.46 * np.cos(2 * np.pi * np.arange(WIN) / (WIN - 1))).astype(np.float32)


def fbank(x: np.ndarray) -> np.ndarray:
    """(frames, 80) centred log-mel features for 16 kHz mono float audio in [-1, 1]."""
    x = x.astype(np.float32) * 32768.0
    n = 1 + (x.size - WIN) // HOP
    if n < 1:
        return np.zeros((0, BINS), dtype=np.float32)
    idx = np.arange(WIN)[None, :] + HOP * np.arange(n)[:, None]
    frames = x[idx]
    frames = frames - frames.mean(axis=1, keepdims=True)
    prev = np.concatenate([frames[:, :1], frames[:, :-1]], axis=1)   # replicate-padded
    frames = (frames - 0.97 * prev) * _WINDOW
    spec = np.fft.rfft(frames, n=NFFT, axis=1)
    power = (spec.real ** 2 + spec.imag ** 2).astype(np.float32)
    feats = np.log(np.maximum(power @ _BANKS, EPS))
    return (feats - feats.mean(axis=0, keepdims=True)).astype(np.float32)
