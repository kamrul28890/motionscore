#!/usr/bin/env python3
"""Shared DSP helpers for the neural stems analyzer.

Imported by ``extract_stems.py`` as ``import extract_events as ee``. It exposes
the librosa-based primitives that analyzer reuses: sample-rate/FFT constants,
robust feature normalization, spectral band slicing, per-frame onset peak
picking, full-mix HPSS feature analysis, the fixed-rate feature-frame sampler,
and structural section-cue detection.

The former standalone CLI analyzer (the smart/beats/onsets modes with their own
``main()`` entry point, argument parsing, candidate/role fusion, beat tracking,
and JSON writer) has been removed. Importing this module has no side effects: it
only defines constants, one dataclass, and pure helper functions. numpy, librosa
and scipy are imported lazily inside the functions that use them.
"""

from __future__ import annotations

from dataclasses import dataclass


SAMPLE_RATE = 22_050
N_FFT = 2_048
HOP_LENGTH = 512
FEATURE_RATE_HZ = 10.0

ROLE_PITCH = {
    "kick": 60.0,
    "bass": 52.0,
    "snare": 72.0,
    "percussion": 80.0,
    "melodic": 68.0,
}


@dataclass
class AnalysisArrays:
    frame_times: "object"
    full_onset: "object"
    percussive_onset: "object"
    harmonic_onset: "object"
    role_envelopes: dict[str, "object"]
    centroid_hz: "object"
    loudness: "object"
    bass_energy: "object"
    brightness: "object"
    onset_density: "object"
    harmonic_energy: "object"
    percussive_energy: "object"


def _clip01(value: float) -> float:
    return max(0.0, min(1.0, float(value)))


def _robust_normalize(values):
    """Normalize a feature to [0, 1] without letting one outlier set the scale."""
    import numpy as np

    values = np.asarray(values, dtype=float)
    if values.size == 0 or not np.any(np.isfinite(values)):
        return np.zeros_like(values, dtype=float)
    finite = values[np.isfinite(values)]
    low = float(np.percentile(finite, 10.0))
    high = float(np.percentile(finite, 95.0))
    if high - low < 1e-10:
        high = float(np.max(finite))
        low = float(np.min(finite))
    if high - low < 1e-10:
        return np.zeros_like(values, dtype=float)
    normalized = (np.nan_to_num(values, nan=low, posinf=high, neginf=low) - low) / (
        high - low
    )
    return np.clip(normalized, 0.0, 1.0)


def _smooth(values, window_frames: int):
    import numpy as np

    values = np.asarray(values, dtype=float)
    if values.size == 0 or window_frames <= 1:
        return values.copy()
    window_frames = min(int(window_frames), values.size)
    left = (window_frames - 1) // 2
    right = window_frames - 1 - left
    padded = np.pad(values, (left, right), mode="edge")
    kernel = np.ones(window_frames, dtype=float) / window_frames
    return np.convolve(padded, kernel, mode="valid")


def _band_slice(freqs, low_hz: float, high_hz: float) -> slice:
    import numpy as np

    start = int(np.searchsorted(freqs, low_hz, side="left"))
    stop = int(np.searchsorted(freqs, high_hz, side="right"))
    start = max(0, min(start, len(freqs) - 1))
    stop = max(start + 1, min(stop, len(freqs)))
    return slice(start, stop)


def _energy_feature(magnitude_spectrogram, band: slice | None = None):
    import numpy as np

    selected = magnitude_spectrogram if band is None else magnitude_spectrogram[band]
    if selected.size == 0:
        return np.zeros(magnitude_spectrogram.shape[1], dtype=float)
    # einsum avoids allocating a second full spectrogram for `selected ** 2`.
    energy = np.sqrt(
        np.maximum(
            np.einsum("ij,ij->j", selected, selected, optimize=True) / selected.shape[0],
            0.0,
        )
    )
    return _robust_normalize(energy)


def _detect_peak_frames(envelope, sr: int, delta: float):
    import numpy as np
    import librosa

    envelope = np.asarray(envelope, dtype=float)
    if envelope.size == 0 or float(np.max(envelope)) < delta:
        return np.asarray([], dtype=int)
    return librosa.onset.onset_detect(
        onset_envelope=envelope,
        sr=sr,
        hop_length=HOP_LENGTH,
        units="frames",
        backtrack=False,
        normalize=False,
        pre_max=1,
        post_max=1,
        pre_avg=6,
        post_avg=2,
        delta=delta,
        wait=2,
    ).astype(int)


def _feature_frames(arrays: AnalysisArrays, duration: float):
    import numpy as np

    if duration <= 0.0 or arrays.frame_times.size == 0:
        return []
    output_times = np.arange(0.0, duration + 0.5 / FEATURE_RATE_HZ, 1.0 / FEATURE_RATE_HZ)
    output_times = output_times[output_times <= duration + 1e-9]
    features = {
        "loudness": arrays.loudness,
        "bassEnergy": arrays.bass_energy,
        "brightness": arrays.brightness,
        "onsetDensity": arrays.onset_density,
        "harmonicEnergy": arrays.harmonic_energy,
        "percussiveEnergy": arrays.percussive_energy,
    }
    sampled = {
        name: np.interp(output_times, arrays.frame_times, values)
        for name, values in features.items()
    }
    frames = []
    for index, time_sec in enumerate(output_times):
        frame = {"timeSec": round(float(time_sec), 4)}
        for name in features:
            frame[name] = round(_clip01(float(sampled[name][index])), 4)
        frames.append(frame)
    return frames


def _contiguous_segments(mask) -> list[tuple[int, int]]:
    segments: list[tuple[int, int]] = []
    start: int | None = None
    for index, enabled in enumerate(mask):
        if enabled and start is None:
            start = index
        elif not enabled and start is not None:
            segments.append((start, index - 1))
            start = None
    if start is not None:
        segments.append((start, len(mask) - 1))
    return segments


def _detect_section_cues(frames: list[dict], duration: float):
    """Detect conservative rises/builds, falls/breakdowns, and drop peaks."""
    import numpy as np

    if len(frames) < int(FEATURE_RATE_HZ * 2.5):
        return []

    times = np.asarray([frame["timeSec"] for frame in frames], dtype=float)
    loudness = np.asarray([frame["loudness"] for frame in frames], dtype=float)
    bass = np.asarray([frame["bassEnergy"] for frame in frames], dtype=float)
    brightness = np.asarray([frame["brightness"] for frame in frames], dtype=float)
    density = np.asarray([frame["onsetDensity"] for frame in frames], dtype=float)
    percussive = np.asarray([frame["percussiveEnergy"] for frame in frames], dtype=float)

    energy = _smooth(0.42 * loudness + 0.33 * bass + 0.15 * density + 0.10 * percussive, 5)

    # Reference the track's own dynamic range instead of absolute thresholds, so
    # cues do not fire on every phrase in consistently-loud material. (The old
    # absolute thresholds produced a "drop" every few seconds on dense music and
    # even on solo piano.)
    lo = float(np.percentile(energy, 25))
    hi = float(np.percentile(energy, 80))
    rng = max(hi - lo, 0.08)
    fps = FEATURE_RATE_HZ

    cues: list[dict] = []

    # Sustained trends: energy change over a multi-second window, expressed as a
    # fraction of the whole-track dynamic range. Only large, sustained moves
    # qualify, which keeps rises/falls rare and meaningful.
    trend_win = max(1, int(round(3.0 * fps)))
    prev_energy = np.concatenate((np.full(trend_win, energy[0]), energy[:-trend_win]))
    norm_delta = (energy - prev_energy) / rng
    min_trend_frames = max(1, int(round(1.5 * fps)))

    for start, end in _contiguous_segments(norm_delta >= 0.55):
        if end - start + 1 < min_trend_frames:
            continue
        seg_start = max(0, start - trend_win)
        peak_index = start + int(np.argmax(norm_delta[start : end + 1]))
        intensity = _clip01(float(norm_delta[peak_index]) / 1.5)
        # 'build' only when energy climbs into the track's high-energy band; the
        # drop pass below may retime a build to end exactly on a detected drop.
        cue_type = "build" if float(energy[end]) >= hi - 0.15 * rng else "rise"
        cues.append(
            {
                "type": cue_type,
                "startSec": round(float(times[seg_start]), 3),
                "endSec": round(float(times[end]), 3),
                "peakSec": round(float(times[peak_index]), 3),
                "intensity": round(intensity, 4),
                "confidence": round(_clip01(0.4 + 0.55 * intensity), 4),
            }
        )

    for start, end in _contiguous_segments(norm_delta <= -0.55):
        if end - start + 1 < min_trend_frames:
            continue
        seg_start = max(0, start - trend_win)
        peak_index = start + int(np.argmin(norm_delta[start : end + 1]))
        intensity = _clip01(-float(norm_delta[peak_index]) / 1.5)
        cue_type = "breakdown" if float(energy[end]) <= lo + 0.15 * rng else "fall"
        cues.append(
            {
                "type": cue_type,
                "startSec": round(float(times[seg_start]), 3),
                "endSec": round(float(times[end]), 3),
                "peakSec": round(float(times[peak_index]), 3),
                "intensity": round(intensity, 4),
                "confidence": round(_clip01(0.4 + 0.55 * intensity), 4),
            }
        )

    # A drop is a transition from a genuine dip (low relative to the whole
    # track) into a sustained high-energy section, confirmed by bass. Rather
    # than a fixed cooldown or a hard count cap, drops are the prominent peaks
    # of a whole-song "drop-likelihood" curve, so the count emerges from the
    # track itself. The only spacing is a ~1s perceptual de-duplication of a
    # single transient, not a musical constraint.
    from scipy.signal import find_peaks

    pre_frames = max(3, int(round(2.0 * fps)))
    post_frames = max(2, int(round(1.5 * fps)))
    drop_score = np.zeros(len(frames), dtype=float)
    for index in range(pre_frames, len(frames) - post_frames):
        pre_energy = float(np.mean(energy[index - pre_frames : index]))
        post_energy = float(np.mean(energy[index : index + post_frames]))
        pre_bass = float(np.mean(bass[index - pre_frames : index]))
        post_bass = float(np.mean(bass[index : index + post_frames]))
        jump = (post_energy - pre_energy) / rng
        bass_jump = (post_bass - pre_bass) / rng
        came_from_dip = pre_energy <= lo + 0.30 * rng
        lands_high = post_energy >= hi - 0.15 * rng
        if came_from_dip and lands_high and jump >= 0.50 and bass_jump >= -0.05:
            drop_score[index] = _clip01(
                0.6 * (jump / 1.2) + 0.4 * (max(0.0, bass_jump) / 1.0)
            )

    # Realign each drop to the strongest local energy/bass edge so a rendered
    # impact lands on the transient itself.
    energy_step = np.maximum(np.diff(energy, prepend=energy[0]), 0.0)
    bass_step = np.maximum(np.diff(bass, prepend=bass[0]), 0.0)
    transition_edge = 0.55 * energy_step + 0.35 * bass_step + 0.10 * density
    align_back = int(round(0.8 * fps))
    align_forward = int(round(0.2 * fps))

    selected_drops: list[tuple[float, int]] = []
    positive = drop_score[drop_score > 0.0]
    if positive.size:
        # Height and prominence adapt to this track's own candidate strengths;
        # `distance` only avoids counting one transient twice (~1s).
        height = max(0.42, float(np.percentile(positive, 50)))
        prominence = max(0.10, float(np.std(positive)) * 0.5)
        dedup_distance = max(1, int(round(1.0 * fps)))
        peak_indices, _props = find_peaks(
            drop_score, height=height, distance=dedup_distance, prominence=prominence
        )
        for raw_index in peak_indices:
            index = int(raw_index)
            search_start = max(1, index - align_back)
            search_end = min(len(frames), index + align_forward + 1)
            aligned_index = search_start + int(
                np.argmax(transition_edge[search_start:search_end])
            )
            selected_drops.append((float(drop_score[index]), aligned_index))

    for score, index in sorted(selected_drops, key=lambda item: item[1]):
        peak_sec = float(times[index])
        # Promote a rise leading into the drop to a build ending on the drop, so
        # offline rendering has the lookahead interval for a long fall.
        for cue in cues:
            cue_end = float(cue["endSec"])
            if (
                cue["type"] in ("rise", "build")
                and float(cue["startSec"]) < peak_sec
                and (cue_end >= peak_sec or peak_sec - cue_end <= 2.0)
            ):
                cue["type"] = "build"
                cue["endSec"] = round(peak_sec, 3)
                cue["peakSec"] = round(peak_sec, 3)
                cue["confidence"] = round(
                    _clip01(max(float(cue["confidence"]), 0.5 + 0.4 * score)), 4
                )
        cues.append(
            {
                "type": "drop",
                "startSec": round(peak_sec, 3),
                "endSec": round(min(duration, peak_sec + 0.5), 3),
                "peakSec": round(peak_sec, 3),
                "intensity": round(_clip01(0.4 + 0.6 * score), 4),
                "confidence": round(_clip01(0.5 + 0.45 * score), 4),
            }
        )

    # No arbitrary count cap: how many cues appear is governed by the
    # whole-track-relative thresholds above, so structure emerges from the music.
    return sorted(cues, key=lambda cue: (cue["startSec"], cue["type"]))


def _analyze_arrays(y, sr: int) -> AnalysisArrays:
    import numpy as np
    import librosa

    complex_spectrogram = librosa.stft(
        y,
        n_fft=N_FFT,
        hop_length=HOP_LENGTH,
        window="hann",
        center=True,
    )
    magnitude = np.abs(complex_spectrogram).astype(np.float32, copy=False)
    del complex_spectrogram
    harmonic, percussive = librosa.decompose.hpss(
        magnitude,
        margin=(1.0, 2.0),
        power=2.0,
    )

    reference = max(float(np.max(magnitude)), 1e-10)
    full_db = librosa.amplitude_to_db(magnitude, ref=reference, top_db=80.0)
    full_onset_raw = librosa.onset.onset_strength(
        S=full_db, sr=sr, hop_length=HOP_LENGTH
    )
    del full_db

    percussive_db = librosa.amplitude_to_db(percussive, ref=reference, top_db=80.0)
    percussive_onset_raw = librosa.onset.onset_strength(
        S=percussive_db, sr=sr, hop_length=HOP_LENGTH
    )

    frequencies = librosa.fft_frequencies(sr=sr, n_fft=N_FFT)
    low_band = _band_slice(frequencies, 20.0, 180.0)
    mid_band = _band_slice(frequencies, 180.0, 2_000.0)
    high_band = _band_slice(frequencies, 2_000.0, sr / 2.0)
    channels = [low_band, mid_band, high_band]

    percussive_bands_raw = librosa.onset.onset_strength_multi(
        S=percussive_db,
        sr=sr,
        hop_length=HOP_LENGTH,
        channels=channels,
        aggregate=np.mean,
    )
    del percussive_db

    harmonic_db = librosa.amplitude_to_db(harmonic, ref=reference, top_db=80.0)
    harmonic_onset_raw = librosa.onset.onset_strength(
        S=harmonic_db, sr=sr, hop_length=HOP_LENGTH, max_size=3
    )
    harmonic_bands_raw = librosa.onset.onset_strength_multi(
        S=harmonic_db,
        sr=sr,
        hop_length=HOP_LENGTH,
        channels=channels,
        aggregate=np.mean,
    )
    del harmonic_db

    full_onset = _robust_normalize(full_onset_raw)
    percussive_onset = _robust_normalize(percussive_onset_raw)
    harmonic_onset = _robust_normalize(harmonic_onset_raw)
    p_low, p_mid, p_high = (_robust_normalize(row) for row in percussive_bands_raw)
    h_low, h_mid, h_high = (_robust_normalize(row) for row in harmonic_bands_raw)

    low_energy = _energy_feature(magnitude, low_band)
    harmonic_low_energy = _energy_feature(harmonic, low_band)
    percussive_low_energy = _energy_feature(percussive, low_band)
    mid_energy = _energy_feature(magnitude, mid_band)
    high_energy = _energy_feature(magnitude, high_band)

    role_envelopes = {
        "kick": np.clip(
            (0.64 * p_low + 0.24 * percussive_onset + 0.12 * p_mid)
            * (0.55 + 0.45 * percussive_low_energy),
            0.0,
            1.0,
        ),
        "bass": np.clip(
            (0.68 * h_low + 0.20 * harmonic_onset + 0.12 * p_low)
            * (0.55 + 0.45 * harmonic_low_energy),
            0.0,
            1.0,
        ),
        "snare": np.clip(
            (0.58 * p_mid + 0.27 * percussive_onset + 0.15 * p_high)
            * (0.58 + 0.42 * mid_energy),
            0.0,
            1.0,
        ),
        "percussion": np.clip(
            (0.68 * p_high + 0.22 * percussive_onset + 0.10 * p_mid)
            * (0.52 + 0.48 * high_energy),
            0.0,
            1.0,
        ),
        "melodic": np.clip(
            (0.56 * h_mid + 0.24 * harmonic_onset + 0.20 * h_high)
            * (0.58 + 0.42 * mid_energy),
            0.0,
            1.0,
        ),
    }

    centroid_hz = librosa.feature.spectral_centroid(S=magnitude, sr=sr)[0]
    rms = librosa.feature.rms(S=magnitude, frame_length=N_FFT, hop_length=HOP_LENGTH)[0]
    harmonic_rms = np.sqrt(
        np.maximum(
            np.einsum("ij,ij->j", harmonic, harmonic, optimize=True) / harmonic.shape[0],
            0.0,
        )
    )
    percussive_rms = np.sqrt(
        np.maximum(
            np.einsum("ij,ij->j", percussive, percussive, optimize=True)
            / percussive.shape[0],
            0.0,
        )
    )

    native_rate = sr / HOP_LENGTH
    smoothing_frames = max(1, int(round(native_rate * 0.65)))
    frame_count = min(
        len(full_onset),
        len(centroid_hz),
        len(rms),
        *(len(values) for values in role_envelopes.values()),
    )
    frame_times = librosa.frames_to_time(
        np.arange(frame_count), sr=sr, hop_length=HOP_LENGTH
    )
    brightness = _robust_normalize(np.log1p(centroid_hz[:frame_count]))

    return AnalysisArrays(
        frame_times=frame_times,
        full_onset=full_onset[:frame_count],
        percussive_onset=percussive_onset[:frame_count],
        harmonic_onset=harmonic_onset[:frame_count],
        role_envelopes={
            role: values[:frame_count] for role, values in role_envelopes.items()
        },
        centroid_hz=centroid_hz[:frame_count],
        loudness=_smooth(_robust_normalize(rms[:frame_count]), max(1, smoothing_frames // 3)),
        bass_energy=_smooth(low_energy[:frame_count], max(1, smoothing_frames // 2)),
        brightness=_smooth(brightness, max(1, smoothing_frames // 3)),
        onset_density=_smooth(full_onset[:frame_count], smoothing_frames),
        harmonic_energy=_smooth(
            _robust_normalize(harmonic_rms[:frame_count]),
            max(1, smoothing_frames // 2),
        ),
        percussive_energy=_smooth(
            _robust_normalize(percussive_rms[:frame_count]),
            max(1, smoothing_frames // 2),
        ),
    )
