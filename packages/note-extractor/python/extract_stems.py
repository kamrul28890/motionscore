#!/usr/bin/env python3
"""Neural per-instrument analysis via Demucs source separation.

Usage:
    python extract_stems.py <audio_path> <output_json> [mode]

Separates the mix into real instrument stems with Demucs (``htdemucs_6s``),
detects onsets per stem, and emits compact continuous activity/register signals
for every visual role. Discrete onset timestamps and continuous signals are kept
separate: impacts stay sample-locked while held audio can drive physical slides.

Full-mix features and section cues reuse ``extract_events.py``. Requires
PyTorch + Demucs in addition to librosa.
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
ROLE_SIGNAL_HZ = ee.FEATURE_RATE_HZ
ROLE_ORDER = (
    "kick",
    "snare",
    "percussion",
    "bass",
    "melodic",
    "piano",
    "guitar",
    "vocal",
)

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
# A single detector cannot resolve two independent attacks inside this window.
# This belongs to onset detection, not renderer-side event dropping.
ROLE_MIN_GAP = 0.09
PITCHED_ROLES = {"bass", "piano", "guitar", "melodic", "vocal"}

# A pitched-stem onset is only real if the stem is actually sounding there: the
# stem's own normalized activity at the onset must clear this floor. This rejects
# separation bleed transients (e.g. a loud guitar leaking into the "silent"
# vocal stem), which otherwise spawn phantom onsets that yank a dormant ball
# back on-screen. It is relative to each stem's own dynamic range, so it is
# song-agnostic and does not touch a stem that is genuinely playing.
ONSET_ACTIVITY_FLOOR = 0.18

# A stem must carry enough of the separated mix to count as present. This rejects
# Demucs bleed before each stem is independently normalized.
STEM_PRESENCE_REL = 0.12
STEM_PRESENCE_ABS = 5e-4

# Continuous-signal shaping. These do not remove discrete onset events.
SIGNAL_ATTACK_SEC = 0.05
SIGNAL_RELEASE_SEC = 0.25
SUSTAIN_ON = 0.30
SUSTAIN_OFF = 0.18
PITCH_ENTER_SEMITONES_PER_SEC = 1.0
PITCH_EXIT_SEMITONES_PER_SEC = 0.4

# Plausible fundamental-frequency range (Hz) per role, used to constrain the
# pYIN pitch tracker on each ISOLATED stem. Because Demucs has already separated
# the instrument, monophonic-ish F0 tracking on the stem is reliable and gives
# real melodic contour (a high note sits high) instead of spectral-centroid
# "brightness", which barely moves for a steady-timbre instrument.
ROLE_F0_HZ = {
    "bass": (41.0, 400.0),      # E1..~G4
    "vocal": (80.0, 1100.0),    # ~E2..~C6
    "guitar": (80.0, 1320.0),   # ~E2..~E6
    "piano": (55.0, 2100.0),    # ~A1..~C7
    "melodic": (65.0, 2100.0),  # generic pitched "other"
}
# pYIN is by far the slowest analysis step, so run it at ~10.8 Hz (a quarter of
# the STFT frame rate). That matches the 10 Hz role-signal output grid (so the
# register-direction signal loses nothing) and is still fine for per-onset pitch
# on spaced notes; pitch is interpolated back onto onset times and the 10 Hz grid.
PYIN_HOP = ee.HOP_LENGTH * 4


def _progress(percent: int, stage: str, message: str) -> None:
    """Emit one machine-readable, line-buffered progress event for the web UI."""
    payload = json.dumps(
        {"percent": int(percent), "stage": stage, "message": message},
        ensure_ascii=True,
        separators=(",", ":"),
    )
    print(f"[motionscore] progress {payload}", file=sys.stderr, flush=True)


def _signal_times(duration, np):
    """Canonical fixed-rate timeline shared with full-mix feature frames."""
    if duration <= 0.0:
        return np.asarray([], dtype=float)
    times = np.arange(
        0.0,
        duration + 0.5 / ROLE_SIGNAL_HZ,
        1.0 / ROLE_SIGNAL_HZ,
        dtype=float,
    )
    return times[times <= duration + 1e-9]


def _smooth_energy(values, hop_sec, np):
    """Causal fast-attack/slow-release smoothing in linear amplitude space."""
    source = np.asarray(values, dtype=float)
    if source.size == 0:
        return source
    output = np.empty_like(source)
    output[0] = max(0.0, float(source[0]))
    for index in range(1, source.size):
        value = max(0.0, float(source[index]))
        tau = SIGNAL_ATTACK_SEC if value >= output[index - 1] else SIGNAL_RELEASE_SEC
        alpha = 1.0 - np.exp(-hop_sec / tau)
        output[index] = output[index - 1] + alpha * (value - output[index - 1])
    return output


def _native_activity(energy, np):
    """Robust role-local activity on the stem's own STFT frames (before resample).

    Fast-attack/slow-release smoothing, then a dB range referenced to the stem's
    own 95th/20th percentiles so the scale is relative to that instrument."""
    values = np.asarray(energy, dtype=float)
    if values.size == 0 or not np.any(np.isfinite(values)):
        return np.zeros(values.shape, dtype=float)
    values = np.nan_to_num(values, nan=0.0, posinf=0.0, neginf=0.0)
    if float(np.max(values)) <= 1e-10:
        return np.zeros(values.shape, dtype=float)

    smoothed = _smooth_energy(values, ee.HOP_LENGTH / ANALYSIS_SR, np)
    db = 20.0 * np.log10(np.maximum(smoothed, 1e-10))
    peak_db = float(np.percentile(db, 95.0))
    noise_db = float(np.percentile(db, 20.0))
    floor_db = max(peak_db - 60.0, min(noise_db, peak_db - 12.0))
    span_db = peak_db - floor_db
    if not np.isfinite(span_db) or span_db <= 1e-6:
        return np.clip(smoothed / max(float(np.max(smoothed)), 1e-10), 0.0, 1.0)
    return np.clip((db - floor_db) / span_db, 0.0, 1.0)


def _normalized_activity(energy, native_times, output_times, np):
    """Robust role-local activity, sampled on the canonical output timeline."""
    if output_times.size == 0:
        return np.asarray([], dtype=float)
    native = _native_activity(energy, np)
    if native.size == 0:
        return np.zeros(output_times.size, dtype=float)
    return np.clip(np.interp(output_times, native_times, native), 0.0, 1.0)


def _sustain_spans(activity):
    """Schmitt-trigger spans; a one-frame dip is bridged, no span-count cap."""
    spans = []
    active = False
    start = 0
    low_run = 0
    for index, value in enumerate(activity):
        if not active:
            if float(value) >= SUSTAIN_ON:
                active = True
                start = index
                low_run = 0
            continue
        if float(value) <= SUSTAIN_OFF:
            low_run += 1
            if low_run >= 2:
                end = index - 1  # first low frame; exclusive
                spans.append([start, max(start + 1, end)])
                active = False
                low_run = 0
        else:
            low_run = 0
    if active:
        spans.append([start, len(activity)])
    return spans


def _median3(values, np):
    if values.size < 2:
        return values.copy()
    output = values.copy()
    for index in range(values.size):
        lo = max(0, index - 1)
        hi = min(values.size, index + 2)
        output[index] = float(np.median(values[lo:hi]))
    return output


def _octave_stabilize(midi, win, np):
    """Fold pYIN octave errors toward a robust local pitch.

    pYIN occasionally reports a note an octave (or two) off for a frame or two,
    which makes the ball dart vertically. For each voiced frame, if it sits close
    to a whole-octave multiple away from the local median, shift it by whole
    octaves back toward that median. Real steps and leaps *within* an octave are
    left untouched, and a genuine sustained octave change is followed once the
    median moves with it — so melodic contour is preserved, only the octave
    glitches are removed. The median is taken over the ORIGINAL track so a single
    outlier cannot drag the reference."""
    n = int(midi.size)
    if n == 0:
        return midi
    out = midi.copy()
    half = max(1, win // 2)
    for i in range(n):
        if not np.isfinite(midi[i]):
            continue
        lo = max(0, i - half)
        hi = min(n, i + half + 1)
        window = midi[lo:hi]
        window = window[np.isfinite(window)]
        if window.size < 3:
            continue
        ref = float(np.median(window))
        diff = float(midi[i]) - ref
        k = int(round(diff / 12.0))
        if k != 0 and abs(diff - 12.0 * k) <= 3.0:
            out[i] = float(np.clip(midi[i] - 12.0 * k, 21.0, 108.0))
    return out


def _pyin_midi(mono, role, np, librosa):
    """Real fundamental-frequency track for one isolated pitched stem.

    Returns ``{"times", "midi", "voiced"}`` on pYIN's own frame grid (MIDI, with
    NaN where unvoiced), or ``None`` if the stem is too short or tracking fails.
    Constraining ``fmin``/``fmax`` per role both speeds up pYIN and rejects
    octave errors and residual bleed outside the instrument's range."""
    fmin, fmax = ROLE_F0_HZ.get(role, (65.0, 2100.0))
    if mono.size < ee.N_FFT:
        return None
    try:
        f0, voiced, _ = librosa.pyin(
            mono,
            fmin=fmin,
            fmax=fmax,
            sr=ANALYSIS_SR,
            frame_length=ee.N_FFT,
            hop_length=PYIN_HOP,
            center=True,
            fill_na=float("nan"),
        )
    except Exception:
        return None
    times = librosa.times_like(f0, sr=ANALYSIS_SR, hop_length=PYIN_HOP)
    midi = np.full(f0.shape, np.nan, dtype=float)
    ok = np.isfinite(f0) & (f0 > 0.0)
    midi[ok] = np.clip(69.0 + 12.0 * np.log2(f0[ok] / 440.0), 21.0, 108.0)
    # Remove octave glitches (~0.9 s window) so the ball follows the melodic
    # contour smoothly instead of darting an octave on a tracking error.
    octave_win = max(5, int(round(0.9 * ANALYSIS_SR / PYIN_HOP)))
    midi = _octave_stabilize(midi, octave_win, np)
    return {"times": times, "midi": midi, "voiced": np.asarray(voiced, dtype=bool)}


def _sample_f0_midi(f0, time_sec, np):
    """MIDI pitch at (or just after) an onset time, or NaN if none nearby.

    An attack frame is often unvoiced, so search a few frames FORWARD into the
    note's sustain first, then a little backward, before giving up."""
    if f0 is None:
        return float("nan")
    times = f0["times"]
    midi = f0["midi"]
    if times.size == 0:
        return float("nan")
    base = int(np.clip(np.searchsorted(times, time_sec), 0, midi.size - 1))
    # Forward-biased, tight search (frames are ~93 ms): prefer this note's
    # sustain just after the attack, without reaching into a neighbouring note.
    for offset in (0, 1, -1, 2):
        index = base + offset
        if 0 <= index < midi.size and np.isfinite(midi[index]):
            return float(midi[index])
    return float("nan")


def _pitch_directions_from_midi(f0, output_times, activity, spans, np):
    """Coarse register motion (rising/steady/falling) from the real F0 track.

    Same Schmitt-trigger over pitch slope as before, but driven by pYIN MIDI
    instead of spectral centroid, so it tracks the actual melody. Direction is
    only emitted where the note is voiced AND the role is active."""
    if f0 is None or output_times.size == 0:
        return [0] * int(output_times.size), 0

    times_native = f0["times"]
    midi_native = f0["midi"]
    voiced_native = f0["voiced"]
    finite = np.isfinite(midi_native)
    if not np.any(finite):
        return [0] * int(output_times.size), 0

    # Hold pitch across short unvoiced gaps so the slope stays continuous, but
    # keep a separate voiced mask so silent/unpitched frames emit no direction.
    midi_held = np.interp(times_native, times_native[finite], midi_native[finite])
    sampled = _median3(np.interp(output_times, times_native, midi_held), np)
    voiced_out = (
        np.interp(output_times, times_native, voiced_native.astype(float)) >= 0.5
    )
    active_frames = np.asarray(activity) >= SUSTAIN_ON
    usable = voiced_out & active_frames
    active_count = int(np.count_nonzero(active_frames))
    coverage = (
        int(np.floor(255.0 * np.count_nonzero(usable) / active_count + 0.5))
        if active_count > 0
        else 0
    )

    directions = np.zeros(output_times.size, dtype=np.int8)
    for start, end in spans:
        state = 0
        for index in range(start, end):
            left = max(start, index - 2)
            right = min(end - 1, index + 2)
            elapsed = float(output_times[right] - output_times[left])
            if elapsed <= 0.0 or not usable[index]:
                directions[index] = 0
                continue
            slope = float(sampled[right] - sampled[left]) / elapsed
            if state == 0:
                if slope >= PITCH_ENTER_SEMITONES_PER_SEC:
                    state = 1
                elif slope <= -PITCH_ENTER_SEMITONES_PER_SEC:
                    state = -1
            elif state > 0:
                if slope <= -PITCH_ENTER_SEMITONES_PER_SEC:
                    state = -1
                elif slope < PITCH_EXIT_SEMITONES_PER_SEC:
                    state = 0
            else:
                if slope >= PITCH_ENTER_SEMITONES_PER_SEC:
                    state = 1
                elif slope > -PITCH_EXIT_SEMITONES_PER_SEC:
                    state = 0
            directions[index] = state
    return directions.astype(int).tolist(), max(0, min(255, coverage))


def _role_track(role, spectrum, duration, np, librosa, f0=None):
    output_times = _signal_times(duration, np)
    native_times = librosa.frames_to_time(
        np.arange(spectrum.shape[1]), sr=ANALYSIS_SR, hop_length=ee.HOP_LENGTH
    )
    energy = np.sqrt(np.mean(np.square(spectrum), axis=0)) if spectrum.size else []
    activity = _normalized_activity(energy, native_times, output_times, np)
    spans = _sustain_spans(activity)
    track = {
        "role": role,
        "activityQ8": np.floor(activity * 255.0 + 0.5).astype(np.uint8).tolist(),
        "sustainSpans": spans,
    }
    if role in PITCHED_ROLES:
        directions, coverage = _pitch_directions_from_midi(
            f0, output_times, activity, spans, np
        )
        track["pitchDirection"] = directions
        track["pitchCoverageQ8"] = coverage
    return track


def _empty_role_track(role, frame_count):
    track = {
        "role": role,
        "activityQ8": [0] * frame_count,
        "sustainSpans": [],
    }
    if role in PITCHED_ROLES:
        track["pitchDirection"] = [0] * frame_count
        track["pitchCoverageQ8"] = 0
    return track


def _build_role_signals(analysis_stems, f0_by_role, duration, np, librosa):
    """Build all eight aligned role tracks from already accepted Demucs stems."""
    output_times = _signal_times(duration, np)
    tracks_by_role = {}
    for name, mono in analysis_stems.items():
        spectrum = np.abs(
            librosa.stft(mono, n_fft=ee.N_FFT, hop_length=ee.HOP_LENGTH)
        )
        if name == "drums":
            freqs = librosa.fft_frequencies(sr=ANALYSIS_SR, n_fft=ee.N_FFT)
            bands = {
                "kick": ee._band_slice(freqs, 20.0, 140.0),
                "snare": ee._band_slice(freqs, 140.0, 2_500.0),
                "percussion": ee._band_slice(freqs, 2_500.0, ANALYSIS_SR / 2.0),
            }
            for role, band in bands.items():
                tracks_by_role[role] = _role_track(
                    role, spectrum[band], duration, np, librosa
                )
        else:
            role = STEM_ROLE.get(name)
            if role is not None:
                tracks_by_role[role] = _role_track(
                    role, spectrum, duration, np, librosa, f0_by_role.get(role)
                )

    frame_count = int(output_times.size)
    tracks = [
        tracks_by_role.get(role, _empty_role_track(role, frame_count))
        for role in ROLE_ORDER
    ]
    return {
        "version": 1,
        "frameRateHz": ROLE_SIGNAL_HZ,
        "frameCount": frame_count,
        "tracks": tracks,
    }


def _stem_onset_events(mono, sr, role, np, librosa, f0=None):
    """Detect onsets in one isolated mono stem; return raw event dicts."""
    spectrum = np.abs(librosa.stft(mono, n_fft=ee.N_FFT, hop_length=ee.HOP_LENGTH))
    reference = max(float(np.max(spectrum)), 1e-10)
    spectrum_db = librosa.amplitude_to_db(spectrum, ref=reference, top_db=80.0)
    onset_env = ee._robust_normalize(
        librosa.onset.onset_strength(S=spectrum_db, sr=sr, hop_length=ee.HOP_LENGTH)
    )
    centroid = librosa.feature.spectral_centroid(S=spectrum, sr=sr)[0]
    frames = ee._detect_peak_frames(onset_env, sr, ROLE_DELTA.get(role, 0.08))
    # Stem-local activity at each frame, so we can reject bleed transients that
    # fire an onset while the instrument is effectively silent (see the floor).
    frame_energy = (
        np.sqrt(np.mean(np.square(spectrum), axis=0)) if spectrum.size else np.asarray([])
    )
    activity_native = _native_activity(frame_energy, np)

    events = []
    previous_time = -1.0
    for raw_frame in frames:
        frame = int(min(max(raw_frame, 0), onset_env.size - 1))
        if frame < activity_native.size and activity_native[frame] < ONSET_ACTIVITY_FLOOR:
            continue
        time_sec = float(librosa.frames_to_time(frame, sr=sr, hop_length=ee.HOP_LENGTH))
        if time_sec - previous_time < ROLE_MIN_GAP:
            continue
        previous_time = time_sec
        strength = float(onset_env[frame])
        salience = ee._clip01(0.3 + 0.7 * strength)
        pitch = ee.ROLE_PITCH.get(role, 64.0)
        if role in PITCHED_ROLES:
            # Prefer the real fundamental at this onset; only fall back to the
            # coarse spectral-centroid estimate when the note is unvoiced or F0
            # tracking is unavailable, so pitch never regresses below before.
            f0_midi = _sample_f0_midi(f0, time_sec, np)
            if np.isfinite(f0_midi):
                pitch = f0_midi
            elif frame < centroid.size:
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


def _export_stems(stems_dir, stem_mono, active, sr, np):
    """Write each present stem as a mono MP3, plus a ``stems.json`` manifest, so
    the web UI can solo/mute individual instruments while watching the scene.

    Levels are preserved (samples are only hard-clipped to [-1, 1] to avoid
    digital wrap, never per-stem normalized), so the unmuted stems still sum to
    roughly the original mix — muting one simply removes that instrument. Note:
    kick/snare/percussion are analysis-only band splits of the single ``drums``
    stem, so only whole Demucs stems (drums/bass/vocals/guitar/piano/other) are
    separately playable here."""
    import os
    import soundfile as sf

    os.makedirs(stems_dir, exist_ok=True)
    manifest = []
    for name in active:
        mono = np.clip(np.asarray(stem_mono.get(name), dtype=np.float32), -1.0, 1.0)
        if mono.size == 0:
            continue
        filename = f"{name}.mp3"
        try:
            sf.write(os.path.join(stems_dir, filename), mono, int(sr), format="MP3")
        except Exception as err:  # noqa: BLE001 - one bad stem must not fail analysis
            print(f"[motionscore] stems: failed to write {filename}: {err}", file=sys.stderr)
            continue
        manifest.append({"name": name, "file": filename})
    with open(os.path.join(stems_dir, "stems.json"), "w", encoding="utf-8") as handle:
        json.dump(manifest, handle)
    return manifest


def _separate(model, wav_t, device, apply_model, torch, shifts):
    # shifts>0 is the Demucs "shift trick" (average predictions over random time
    # offsets) which reduces separation artifacts; per the docs it is only worth
    # it on GPU, so callers pass 0 on CPU. overlap=0.25 is the recommended
    # default; `segment` is intentionally left at the model default (Hybrid
    # Transformer models are capped at 7.8s, so forcing a larger value errors).
    with torch.no_grad():
        return apply_model(
            model,
            wav_t[None],
            device=device,
            shifts=shifts,
            split=True,
            overlap=0.25,
            progress=False,
        )[0]


def main() -> int:
    if len(sys.argv) < 3:
        print("usage: extract_stems.py <audio_path> <output_json> [mode]", file=sys.stderr)
        return 2

    audio_path = sys.argv[1]
    out_path = sys.argv[2]
    # Optional 4th arg: a directory to write per-stem audio (+ a stems.json
    # manifest) for the web mixer. argv[3] is the legacy mode token ("stems").
    stems_dir = sys.argv[4] if len(sys.argv) > 4 else None
    warnings.filterwarnings("ignore")

    _progress(16, "Environment", "Loading neural audio dependencies")
    import numpy as np
    import librosa
    import torch
    from demucs.apply import apply_model
    from demucs.pretrained import get_model

    device = "cuda" if torch.cuda.is_available() else "cpu"
    _progress(20, "Model loading", f"Loading {MODEL_NAME} on {device.upper()}")
    model = get_model(MODEL_NAME)
    model.eval()
    model_sr = model.samplerate
    sources = list(model.sources)

    # Load stereo at the model's sample rate for separation.
    _progress(24, "Audio decoding", "Decoding and resampling the uploaded audio")
    wav, _ = librosa.load(audio_path, sr=model_sr, mono=False)
    if wav.ndim == 1:
        wav = np.stack([wav, wav])
    duration = wav.shape[-1] / model_sr

    wav_t = torch.from_numpy(np.ascontiguousarray(wav)).float()
    reference = wav_t.mean(0)
    mean = reference.mean()
    std = reference.std() + 1e-8
    wav_t = (wav_t - mean) / std

    # Shift trick (shifts): each shift is a random-offset pass, so a real quality
    # gain needs shifts>=2 (averaging), at a proportional time cost, and it makes
    # separation non-deterministic. We consume the stems only for coarse
    # onset/pitch analysis, where that marginal SDR gain is irrelevant but
    # determinism (same song -> same visualization) and speed matter — so it
    # stays off. Bump this (GPU only, per the docs) if you need cleaner *audio*.
    shifts = 0
    _progress(
        30,
        "Source separation",
        f"Separating the mix into {len(sources)} components on {device.upper()}",
    )
    print(
        f"[motionscore] stems: separating on {device.upper()} "
        f"(model {MODEL_NAME}, shifts={shifts})",
        file=sys.stderr,
        flush=True,
    )

    try:
        est = _separate(model, wav_t, device, apply_model, torch, shifts)
    except RuntimeError as err:
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
            est = _separate(model, wav_t, device, apply_model, torch, 0)
        else:
            raise
    est = (est * std + mean).cpu().numpy()

    stems = {name: est[i] for i, name in enumerate(sources)}
    stem_mono = {name: audio.mean(0) for name, audio in stems.items()}
    stem_rms = {
        name: (float(np.sqrt(np.mean(np.square(mono)))) if mono.size else 0.0)
        for name, mono in stem_mono.items()
    }
    loudest = max(stem_rms.values()) if stem_rms else 0.0
    presence_floor = max(STEM_PRESENCE_ABS, STEM_PRESENCE_REL * loudest)

    events = []
    active = [name for name in sources if stem_rms.get(name, 0.0) >= presence_floor]
    _progress(
        58,
        "Stem detection",
        f"Found {len(active)} active component{'s' if len(active) != 1 else ''}",
    )
    analysis_stems = {}
    f0_by_role = {}
    for index, name in enumerate(active):
        mono = stem_mono[name]
        analysis_percent = 60 + round(15 * index / max(1, len(active) - 1))
        _progress(
            analysis_percent,
            "Instrument analysis",
            f"Detecting onsets and pitch for {name}",
        )
        mono_a = librosa.resample(mono, orig_sr=model_sr, target_sr=ANALYSIS_SR)
        analysis_stems[name] = mono_a
        if name == "drums":
            events.extend(_drum_role_events(mono_a, ANALYSIS_SR, np, librosa))
        else:
            role = STEM_ROLE.get(name)
            if role is not None:
                # One F0 track per pitched stem, reused for both the per-onset
                # pitch and the continuous register-direction signal.
                f0 = _pyin_midi(mono_a, role, np, librosa) if role in PITCHED_ROLES else None
                if f0 is not None:
                    f0_by_role[role] = f0
                events.extend(
                    _stem_onset_events(mono_a, ANALYSIS_SR, role, np, librosa, f0)
                )
    events.sort(key=lambda event: event["timeSec"])

    # Optional: write per-stem audio for the web mixer (mute/solo instruments).
    if stems_dir:
        _progress(78, "Stem export", "Encoding individually playable components")
        try:
            _export_stems(stems_dir, stem_mono, active, model_sr, np)
        except Exception as err:  # noqa: BLE001 - stem export is best-effort
            print(f"[motionscore] stems: export failed ({err})", file=sys.stderr)

    _progress(84, "Role signals", "Building activity, sustain, and pitch-direction timelines")
    role_signals = _build_role_signals(analysis_stems, f0_by_role, duration, np, librosa)

    # Continuous full-mix features + structural section cues.
    _progress(90, "Song structure", "Measuring tempo, energy, and musical sections")
    y_full = librosa.to_mono(wav)
    y_a = librosa.resample(y_full, orig_sr=model_sr, target_sr=ANALYSIS_SR)
    arrays = ee._analyze_arrays(y_a, ANALYSIS_SR)
    frames = ee._feature_frames(arrays, duration)
    cues = ee._detect_section_cues(frames, duration)

    try:
        tempo_arr, _ = librosa.beat.beat_track(
            onset_envelope=arrays.percussive_onset,
            sr=ANALYSIS_SR,
            hop_length=ee.HOP_LENGTH,
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
        "roleSignals": role_signals,
    }
    _progress(96, "Result encoding", "Writing the validated analysis payload")
    with open(out_path, "w", encoding="utf-8") as output_file:
        json.dump(result, output_file, allow_nan=False, separators=(",", ":"))

    role_counts: dict[str, int] = {}
    for event in events:
        role_counts[event["role"]] = role_counts.get(event["role"], 0) + 1
    rms_report = {name: round(value, 4) for name, value in stem_rms.items()}
    print(
        f"extract_stems: device={device} model={MODEL_NAME} events={len(events)} "
        f"roles={role_counts} active={active} stem_rms={rms_report} "
        f"signal_frames={role_signals['frameCount']} cues={len(cues)} "
        f"tempo={tempo:.1f}bpm dur={duration:.1f}s",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
