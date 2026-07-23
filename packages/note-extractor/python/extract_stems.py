#!/usr/bin/env python3
"""Neural per-instrument analysis via Demucs source separation.

Usage:
    python extract_stems.py <audio_path> <output_json> [mode]

Separates the mix into real instrument stems with Demucs (``htdemucs_6s``:
drums, bass, other, vocals, guitar, piano), detects onsets *per stem*, and tags
each hit with a real instrument role. Because the stems are isolated, a piano
onset is labelled ``piano`` (not guessed from a frequency band), so a per-role
ball can follow the actual piano.

Continuous features and section cues are computed from the full mix by reusing
``extract_events.py``, so the JSON schema is identical to the librosa analyzer
(``mode="stems"``). Requires PyTorch + Demucs in addition to librosa.
"""

from __future__ import annotations

import json
import sys
import warnings
from pathlib import Path

# Reuse the librosa analyzer's helpers/constants (same directory).
sys.path.insert(0, str(Path(__file__).resolve().parent))
import extract_events as ee  # noqa: E402

MODEL_NAME = "htdemucs_6s"
ANALYSIS_SR = ee.SAMPLE_RATE  # 22.05 kHz for onset/feature analysis

# Demucs (non-drum) stem name -> our role. Drums is split separately below.
STEM_ROLE = {
    "bass": "bass",
    "vocals": "vocal",
    "guitar": "guitar",
    "piano": "piano",
    "other": "melodic",
}

# Onset peak-pick sensitivity per role (lower = more hits).
ROLE_DELTA = {
    "kick": 0.06,
    "snare": 0.07,
    "percussion": 0.09,
    "bass": 0.08,
    "vocal": 0.08,
    "piano": 0.07,
    "guitar": 0.07,
    "melodic": 0.08,
}
# A single instrument cannot re-strike faster than this (seconds).
ROLE_MIN_GAP = 0.09
# Roles whose ball x should follow pitch (via spectral centroid), not a lane base.
PITCHED_ROLES = {"bass", "piano", "guitar", "melodic", "vocal"}

# A stem must carry at least this fraction of the loudest stem's RMS to count as
# "present". Quieter stems are Demucs separation bleed (e.g. the faint drums a
# solo-piano track leaks into), so we skip them entirely -- otherwise an isolated
# instrument spawns phantom hits in every role because each stem's onset envelope
# is normalized independently. Full-band mixes keep every stem (all are loud).
STEM_PRESENCE_REL = 0.12
STEM_PRESENCE_ABS = 5e-4


def _stem_onset_events(mono, sr, role, np, librosa):
    """Detect onsets in one isolated mono stem; return raw event dicts."""
    spectrum = np.abs(librosa.stft(mono, n_fft=ee.N_FFT, hop_length=ee.HOP_LENGTH))
    reference = max(float(np.max(spectrum)), 1e-10)
    spectrum_db = librosa.amplitude_to_db(spectrum, ref=reference, top_db=80.0)
    onset_env = ee._robust_normalize(
        librosa.onset.onset_strength(S=spectrum_db, sr=sr, hop_length=ee.HOP_LENGTH)
    )
    centroid = librosa.feature.spectral_centroid(S=spectrum, sr=sr)[0]
    frames = ee._detect_peak_frames(onset_env, sr, ROLE_DELTA.get(role, 0.08))

    events = []
    previous_time = -1.0
    for raw_frame in frames:
        frame = int(min(max(raw_frame, 0), onset_env.size - 1))
        time_sec = float(librosa.frames_to_time(frame, sr=sr, hop_length=ee.HOP_LENGTH))
        if time_sec - previous_time < ROLE_MIN_GAP:
            continue
        previous_time = time_sec
        strength = float(onset_env[frame])
        salience = ee._clip01(0.3 + 0.7 * strength)
        pitch = ee.ROLE_PITCH.get(role, 64.0)
        if role in PITCHED_ROLES and frame < centroid.size:
            hz = float(centroid[frame])
            if hz > 0.0 and np.isfinite(hz):
                spectral = 69.0 + 12.0 * np.log2(hz / 440.0)
                pitch = 0.5 * pitch + 0.5 * max(40.0, min(84.0, spectral))
        events.append(
            {
                "timeSec": round(time_sec, 6),
                "pitchMidi": int(max(21, min(108, round(pitch)))),
                "velocity": round(ee._clip01(0.25 + 0.75 * salience), 4),
                "role": role,
                "confidence": round(ee._clip01(0.55 + 0.4 * strength), 4),
                "salience": round(salience, 4),
            }
        )
    return events


def _drum_role_events(mono, sr, np, librosa):
    """Split the isolated drum stem into kick/snare/percussion by band."""
    spectrum = np.abs(librosa.stft(mono, n_fft=ee.N_FFT, hop_length=ee.HOP_LENGTH))
    reference = max(float(np.max(spectrum)), 1e-10)
    spectrum_db = librosa.amplitude_to_db(spectrum, ref=reference, top_db=80.0)
    freqs = librosa.fft_frequencies(sr=sr, n_fft=ee.N_FFT)
    bands = {
        "kick": ee._band_slice(freqs, 20.0, 140.0),
        "snare": ee._band_slice(freqs, 140.0, 2_500.0),
        "percussion": ee._band_slice(freqs, 2_500.0, sr / 2.0),
    }

    events = []
    for role, band in bands.items():
        onset_env = ee._robust_normalize(
            librosa.onset.onset_strength(
                S=spectrum_db[band], sr=sr, hop_length=ee.HOP_LENGTH
            )
        )
        frames = ee._detect_peak_frames(onset_env, sr, ROLE_DELTA[role])
        previous_time = -1.0
        for raw_frame in frames:
            frame = int(min(max(raw_frame, 0), onset_env.size - 1))
            time_sec = float(librosa.frames_to_time(frame, sr=sr, hop_length=ee.HOP_LENGTH))
            if time_sec - previous_time < ROLE_MIN_GAP:
                continue
            previous_time = time_sec
            strength = float(onset_env[frame])
            salience = ee._clip01(0.3 + 0.7 * strength)
            events.append(
                {
                    "timeSec": round(time_sec, 6),
                    "pitchMidi": int(max(21, min(108, round(ee.ROLE_PITCH[role])))),
                    "velocity": round(ee._clip01(0.25 + 0.75 * salience), 4),
                    "role": role,
                    "confidence": round(ee._clip01(0.55 + 0.4 * strength), 4),
                    "salience": round(salience, 4),
                }
            )
    return events


def _separate(model, wav_t, device, apply_model, torch):
    with torch.no_grad():
        return apply_model(
            model, wav_t[None], device=device, split=True, overlap=0.25, progress=False
        )[0]


def main() -> int:
    if len(sys.argv) < 3:
        print("usage: extract_stems.py <audio_path> <output_json> [mode]", file=sys.stderr)
        return 2

    audio_path = sys.argv[1]
    out_path = sys.argv[2]
    warnings.filterwarnings("ignore")

    import numpy as np
    import librosa
    import torch
    from demucs.apply import apply_model
    from demucs.pretrained import get_model

    device = "cuda" if torch.cuda.is_available() else "cpu"
    model = get_model(MODEL_NAME)
    model.eval()
    model_sr = model.samplerate
    sources = list(model.sources)

    # Load stereo at the model's sample rate for separation.
    wav, _ = librosa.load(audio_path, sr=model_sr, mono=False)
    if wav.ndim == 1:
        wav = np.stack([wav, wav])
    duration = wav.shape[-1] / model_sr

    wav_t = torch.from_numpy(np.ascontiguousarray(wav)).float()
    reference = wav_t.mean(0)
    mean = reference.mean()
    std = reference.std() + 1e-8
    wav_t = (wav_t - mean) / std

    # Announce the device before the heavy separation so callers can confirm
    # whether the GPU is actually in use. audio-events.ts forwards any
    # "[motionscore]" line to the CLI verbose log and the web progress stream.
    print(
        f"[motionscore] stems: separating on {device.upper()} (model {MODEL_NAME})",
        file=sys.stderr,
        flush=True,
    )

    try:
        est = _separate(model, wav_t, device, apply_model, torch)
    except RuntimeError as err:
        # Fall back to CPU on any CUDA runtime error (OOM, missing kernel, etc.).
        if device == "cuda":
            print(
                f"[motionscore] stems: CUDA failed ({err}); retrying on CPU",
                file=sys.stderr,
                flush=True,
            )
            try:
                torch.cuda.empty_cache()
            except Exception:
                pass
            device = "cpu"
            est = _separate(model, wav_t, device, apply_model, torch)
        else:
            raise
    est = (est * std + mean).cpu().numpy()

    stems = {name: est[i] for i, name in enumerate(sources)}

    # Loudness per stem (RMS on the model-rate mono). Near-silent stems are
    # separation bleed; skipping them stops phantom cross-role hits.
    stem_mono = {name: audio.mean(0) for name, audio in stems.items()}
    stem_rms = {
        name: (float(np.sqrt(np.mean(np.square(mono)))) if mono.size else 0.0)
        for name, mono in stem_mono.items()
    }
    loudest = max(stem_rms.values()) if stem_rms else 0.0
    presence_floor = max(STEM_PRESENCE_ABS, STEM_PRESENCE_REL * loudest)

    events = []
    active = []
    for name, mono in stem_mono.items():
        if stem_rms[name] < presence_floor:
            continue
        active.append(name)
        mono_a = librosa.resample(mono, orig_sr=model_sr, target_sr=ANALYSIS_SR)
        if name == "drums":
            events.extend(_drum_role_events(mono_a, ANALYSIS_SR, np, librosa))
        else:
            role = STEM_ROLE.get(name)
            if role is not None:
                events.extend(_stem_onset_events(mono_a, ANALYSIS_SR, role, np, librosa))
    events.sort(key=lambda event: event["timeSec"])

    # Continuous features + section cues from the full mix (reuse librosa path).
    y_full = librosa.to_mono(wav)
    y_a = librosa.resample(y_full, orig_sr=model_sr, target_sr=ANALYSIS_SR)
    arrays = ee._analyze_arrays(y_a, ANALYSIS_SR)
    frames = ee._feature_frames(arrays, duration)
    cues = ee._detect_section_cues(frames, duration)

    try:
        tempo_arr, _ = librosa.beat.beat_track(
            onset_envelope=arrays.percussive_onset, sr=ANALYSIS_SR, hop_length=ee.HOP_LENGTH
        )
        tempo = float(np.atleast_1d(tempo_arr)[0]) if np.size(tempo_arr) else 0.0
    except Exception:
        tempo = 0.0

    result = {
        "version": 1,
        "durationSec": round(duration, 6),
        "tempo": round(tempo, 2),
        "mode": "stems",
        "events": events,
        "featureFrames": frames,
        "sectionCues": cues,
    }
    with open(out_path, "w", encoding="utf-8") as output_file:
        json.dump(result, output_file, allow_nan=False, separators=(",", ":"))

    role_counts: dict[str, int] = {}
    for event in events:
        role_counts[event["role"]] = role_counts.get(event["role"], 0) + 1
    rms_report = {name: round(value, 4) for name, value in stem_rms.items()}
    print(
        f"extract_stems: device={device} model={MODEL_NAME} events={len(events)} "
        f"roles={role_counts} active={active} stem_rms={rms_report} "
        f"cues={len(cues)} tempo={tempo:.1f}bpm dur={duration:.1f}s",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
