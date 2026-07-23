#!/usr/bin/env python3
"""Extract musically useful hit events and structural cues from audio.

Usage:
    python extract_events.py <audio_path> <output_json> [smart|beats|onsets]

Modes:
    smart   HPSS + frequency-band onset fusion. Keeps salient drum, bass, and
            melodic attacks while merging simultaneous/repetitive transients.
    beats   Percussive beat tracker, retained as the sparse comparison mode.
    onsets  Full-mix onset detector, retained as the denser comparison mode.

The JSON includes discrete events for the ball, a 10 Hz continuous feature
track for future scene animation, and section cues such as builds and drops.
No neural model is required: this uses librosa's open-source HPSS, onset,
beat, and spectral-feature primitives already installed in the project venv.
"""

from __future__ import annotations

from dataclasses import dataclass
import json
import sys
import warnings
from typing import Iterable


SAMPLE_RATE = 22_050
N_FFT = 2_048
HOP_LENGTH = 512
FEATURE_RATE_HZ = 10.0
MERGE_WINDOW_SEC = 0.095
MIN_HIT_GAP_SEC = 0.09
MAX_HITS_PER_SECOND = 8
# Full-song HPSS still requires spectrogram-sized working memory. Reject very
# long uploads before decoding/allocating matrices; longer mixes should be
# split into sections or handled by a future chunked analyzer.
MAX_AUDIO_DURATION_SEC = 12 * 60

ROLES = ("kick", "bass", "snare", "percussion", "melodic")
ROLE_PRIORITY = {
    "kick": 1.15,
    "bass": 1.10,
    "snare": 1.05,
    "melodic": 1.00,
    "percussion": 0.86,
}
ROLE_PITCH = {
    "kick": 60.0,
    "bass": 52.0,
    "snare": 72.0,
    "percussion": 80.0,
    "melodic": 68.0,
}
ROLE_MIN_SALIENCE = {
    "kick": 0.23,
    "bass": 0.25,
    "snare": 0.28,
    "percussion": 0.38,
    "melodic": 0.34,
}
ROLE_PEAK_DELTA = {
    "kick": 0.07,
    "bass": 0.08,
    "snare": 0.08,
    "percussion": 0.11,
    "melodic": 0.10,
}


@dataclass
class Candidate:
    frame: int
    time_sec: float
    role: str
    strength: float
    salience: float
    confidence: float

    @property
    def rank(self) -> float:
        return self.salience * ROLE_PRIORITY[self.role]


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


def _beat_bonus(time_sec: float, beat_times) -> float:
    import numpy as np

    if beat_times.size == 0:
        return 0.0
    index = int(np.searchsorted(beat_times, time_sec))
    distances = []
    if index < beat_times.size:
        distances.append(abs(float(beat_times[index]) - time_sec))
    if index > 0:
        distances.append(abs(float(beat_times[index - 1]) - time_sec))
    nearest = min(distances, default=1.0)
    return _clip01(1.0 - nearest / 0.08)


def _dominant_role(role_envelopes: dict[str, "object"], frame: int) -> tuple[str, float]:
    role = max(
        ROLES,
        key=lambda name: float(role_envelopes[name][frame]) * ROLE_PRIORITY[name],
    )
    return role, float(role_envelopes[role][frame])


def _build_candidates(
    mode: str,
    arrays: AnalysisArrays,
    beat_frames,
    beat_times,
    sr: int,
) -> list[Candidate]:
    import numpy as np
    import librosa

    candidates: list[Candidate] = []

    if mode == "beats":
        source_frames: Iterable[int] = beat_frames
        for raw_frame in source_frames:
            frame = min(max(int(raw_frame), 0), arrays.full_onset.size - 1)
            role, role_strength = _dominant_role(arrays.role_envelopes, frame)
            global_strength = float(arrays.full_onset[frame])
            salience = _clip01(0.60 * global_strength + 0.40 * role_strength)
            candidates.append(
                Candidate(
                    frame=frame,
                    time_sec=float(librosa.frames_to_time(frame, sr=sr, hop_length=HOP_LENGTH)),
                    role=role,
                    strength=max(global_strength, role_strength),
                    salience=max(0.30, salience),
                    confidence=_clip01(0.35 + 0.65 * salience),
                )
            )
        return candidates

    if mode == "onsets":
        onset_frames = _detect_peak_frames(arrays.full_onset, sr, delta=0.08)
        for raw_frame in onset_frames:
            frame = min(max(int(raw_frame), 0), arrays.full_onset.size - 1)
            role, role_strength = _dominant_role(arrays.role_envelopes, frame)
            global_strength = float(arrays.full_onset[frame])
            salience = _clip01(0.72 * global_strength + 0.28 * role_strength)
            if salience < 0.18:
                continue
            candidates.append(
                Candidate(
                    frame=frame,
                    time_sec=float(librosa.frames_to_time(frame, sr=sr, hop_length=HOP_LENGTH)),
                    role=role,
                    strength=max(global_strength, role_strength),
                    salience=salience,
                    confidence=_clip01(0.25 + 0.75 * salience),
                )
            )
        return candidates

    # Smart mode detects each pseudo-stem independently. The merge pass below
    # combines simultaneous kick/bass/snare/etc. attacks into one hittable event.
    for role in ROLES:
        envelope = arrays.role_envelopes[role]
        peak_frames = _detect_peak_frames(envelope, sr, ROLE_PEAK_DELTA[role])
        for raw_frame in peak_frames:
            frame = min(max(int(raw_frame), 0), arrays.full_onset.size - 1)
            role_strength = float(envelope[frame])
            global_strength = float(arrays.full_onset[frame])
            bonus = _beat_bonus(
                float(librosa.frames_to_time(frame, sr=sr, hop_length=HOP_LENGTH)),
                beat_times,
            )
            # Harmonic low-band envelopes can ring around a sustained bass tone.
            # Require either visible full-mix evidence or an exceptionally clear
            # independent stem attack; this preserves syncopated bass while
            # removing artificial in-between hits.
            if (
                role in ("bass", "melodic")
                and global_strength < 0.04
                and role_strength < 0.95
            ):
                continue
            salience = _clip01(
                0.62 * role_strength + 0.28 * global_strength + 0.10 * bonus
            )
            if salience < ROLE_MIN_SALIENCE[role]:
                continue
            candidates.append(
                Candidate(
                    frame=frame,
                    time_sec=float(librosa.frames_to_time(frame, sr=sr, hop_length=HOP_LENGTH)),
                    role=role,
                    strength=max(role_strength, global_strength),
                    salience=salience,
                    confidence=_clip01(
                        0.20 + 0.62 * salience + 0.18 * min(1.0, role_strength)
                    ),
                )
            )
    return candidates


def _merge_candidates(candidates: list[Candidate]) -> list[Candidate]:
    """Merge simultaneous pseudo-stem spikes and suppress low-value repetition."""
    if not candidates:
        return []

    ordered = sorted(candidates, key=lambda item: (item.time_sec, -item.rank))
    clusters: list[list[Candidate]] = []
    cluster: list[Candidate] = []
    cluster_start = 0.0
    for candidate in ordered:
        if not cluster or candidate.time_sec - cluster_start <= MERGE_WINDOW_SEC:
            if not cluster:
                cluster_start = candidate.time_sec
            cluster.append(candidate)
        else:
            clusters.append(cluster)
            cluster = [candidate]
            cluster_start = candidate.time_sec
    if cluster:
        clusters.append(cluster)

    merged: list[Candidate] = []
    for group in clusters:
        dominant = max(group, key=lambda item: item.rank)
        role_count = len({item.role for item in group})
        merged.append(
            Candidate(
                frame=dominant.frame,
                time_sec=dominant.time_sec,
                role=dominant.role,
                strength=max(item.strength for item in group),
                salience=_clip01(
                    max(item.salience for item in group) + 0.05 * (role_count - 1)
                ),
                confidence=_clip01(
                    max(item.confidence for item in group) + 0.04 * (role_count - 1)
                ),
            )
        )

    # A single ball cannot communicate two different hits within ~90 ms. Keep
    # the more salient event rather than always keeping the earlier one.
    spaced: list[Candidate] = []
    for candidate in merged:
        if spaced and candidate.time_sec - spaced[-1].time_sec < MIN_HIT_GAP_SEC:
            if candidate.rank > spaced[-1].rank:
                spaced[-1] = candidate
            continue

        # Constant high-frequency sixteenth notes otherwise dominate many
        # mixes. Keep close repetitions only when the new transient is strong.
        if (
            spaced
            and candidate.role == "percussion"
            and spaced[-1].role == "percussion"
            and candidate.time_sec - spaced[-1].time_sec < 0.16
            and candidate.salience < 0.76
        ):
            if candidate.rank > spaced[-1].rank:
                spaced[-1] = candidate
            continue
        spaced.append(candidate)

    # Fixed one-second salience cap is a final safety valve for unusually noisy
    # material. Typical songs remain below it after merge/repetition suppression.
    buckets: dict[int, list[Candidate]] = {}
    for candidate in spaced:
        buckets.setdefault(int(candidate.time_sec), []).append(candidate)
    capped: list[Candidate] = []
    for bucket in buckets.values():
        capped.extend(
            sorted(bucket, key=lambda item: item.rank, reverse=True)[
                :MAX_HITS_PER_SECOND
            ]
        )
    return sorted(capped, key=lambda item: item.time_sec)


def _candidate_pitch(candidate: Candidate, centroid_hz, previous_pitch: float, previous_time: float) -> float:
    import numpy as np

    raw_pitch = ROLE_PITCH[candidate.role]
    if candidate.role == "melodic":
        hz = float(centroid_hz[candidate.frame])
        if hz > 0.0 and np.isfinite(hz):
            spectral_pitch = 69.0 + 12.0 * np.log2(hz / 440.0)
            raw_pitch = 0.65 * raw_pitch + 0.35 * max(56.0, min(82.0, spectral_pitch))

    # Slew-limit the position hint. Short event gaps permit only small lane
    # changes; longer phrases can travel farther. This is a hint encoded in the
    # existing pitch field, not an attempt to transcribe the actual pitch.
    delta_sec = max(0.0, candidate.time_sec - previous_time)
    max_delta = 4.0 + 18.0 * min(delta_sec, 0.75)
    return previous_pitch + max(-max_delta, min(max_delta, raw_pitch - previous_pitch))


def _events_from_candidates(candidates: list[Candidate], arrays: AnalysisArrays):
    events = []
    previous_pitch = 64.0
    previous_time = 0.0
    for candidate in candidates:
        pitch = _candidate_pitch(
            candidate,
            arrays.centroid_hz,
            previous_pitch,
            previous_time,
        )
        previous_pitch = pitch
        previous_time = candidate.time_sec
        velocity = _clip01(0.25 + 0.75 * candidate.salience)
        events.append(
            {
                "timeSec": round(candidate.time_sec, 6),
                "pitchMidi": int(max(21, min(108, round(pitch)))),
                "velocity": round(velocity, 4),
                "role": candidate.role,
                "confidence": round(candidate.confidence, 4),
                "salience": round(candidate.salience, 4),
            }
        )
    return events


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
    lookback = max(1, int(round(2.0 * FEATURE_RATE_HZ)))
    previous = np.concatenate((np.full(lookback, energy[0]), energy[:-lookback]))
    previous_density = np.concatenate((np.full(lookback, density[0]), density[:-lookback]))
    previous_brightness = np.concatenate((np.full(lookback, brightness[0]), brightness[:-lookback]))

    energy_change = energy - previous
    density_change = _smooth(density, 5) - _smooth(previous_density, 5)
    brightness_change = _smooth(brightness, 5) - _smooth(previous_brightness, 5)
    rise_score = np.clip(
        0.55 * np.maximum(energy_change, 0.0) / 0.35
        + 0.27 * np.maximum(density_change, 0.0) / 0.35
        + 0.18 * np.maximum(brightness_change, 0.0) / 0.35,
        0.0,
        1.0,
    )
    fall_score = np.clip(
        0.68 * np.maximum(-energy_change, 0.0) / 0.35
        + 0.20 * np.maximum(-density_change, 0.0) / 0.35
        + 0.12 * np.maximum(-brightness_change, 0.0) / 0.35,
        0.0,
        1.0,
    )

    cues: list[dict] = []
    min_trend_frames = max(6, int(round(0.8 * FEATURE_RATE_HZ)))
    for start, end in _contiguous_segments(rise_score >= 0.34):
        if end - start + 1 < min_trend_frames:
            continue
        actual_start = max(0, start - lookback)
        peak_index = start + int(np.argmax(rise_score[start : end + 1]))
        intensity = _clip01(float(rise_score[peak_index]))
        density_gain = float(density[end] - density[actual_start])
        cue_type = "build" if density_gain > 0.10 and intensity >= 0.48 else "rise"
        cues.append(
            {
                "type": cue_type,
                "startSec": round(float(times[actual_start]), 3),
                "endSec": round(float(times[end]), 3),
                "peakSec": round(float(times[peak_index]), 3),
                "intensity": round(intensity, 4),
                "confidence": round(_clip01(0.35 + 0.60 * intensity), 4),
            }
        )

    for start, end in _contiguous_segments(fall_score >= 0.36):
        if end - start + 1 < min_trend_frames:
            continue
        peak_index = start + int(np.argmax(fall_score[start : end + 1]))
        intensity = _clip01(float(fall_score[peak_index]))
        cue_type = "breakdown" if float(energy[end]) < 0.38 else "fall"
        cues.append(
            {
                "type": cue_type,
                "startSec": round(float(times[start]), 3),
                "endSec": round(float(times[end]), 3),
                "peakSec": round(float(times[peak_index]), 3),
                "intensity": round(intensity, 4),
                "confidence": round(_clip01(0.35 + 0.60 * intensity), 4),
            }
        )

    # A drop is a short broadband + bass jump after a quieter window. Use local
    # maxima and a cooldown so one transition produces one cue, not many frames.
    drop_candidates: list[tuple[float, int]] = []
    pre_frames = max(4, int(round(1.0 * FEATURE_RATE_HZ)))
    post_frames = max(2, int(round(0.5 * FEATURE_RATE_HZ)))
    for index in range(pre_frames, len(frames) - post_frames):
        pre_energy = float(np.mean(energy[index - pre_frames : index - 1]))
        post_energy = float(np.mean(energy[index : index + post_frames]))
        pre_bass = float(np.mean(bass[index - pre_frames : index - 1]))
        post_bass = float(np.mean(bass[index : index + post_frames]))
        energy_jump = max(0.0, post_energy - pre_energy)
        bass_jump = max(0.0, post_bass - pre_bass)
        onset_peak = float(np.max(density[max(0, index - 1) : index + 2]))
        instant_jump = max(0.0, float(energy[index] - energy[max(0, index - 2)]))
        score = _clip01(
            0.42 * energy_jump / 0.35
            + 0.34 * bass_jump / 0.35
            + 0.14 * instant_jump / 0.25
            + 0.10 * onset_peak
        )
        if score >= 0.46 and energy_jump >= 0.10 and post_energy >= 0.42:
            drop_candidates.append((score, index))

    selected_drops: list[tuple[float, int]] = []
    cooldown_frames = int(round(3.0 * FEATURE_RATE_HZ))
    for score, index in sorted(drop_candidates, reverse=True):
        if any(abs(index - kept_index) < cooldown_frames for _, kept_index in selected_drops):
            continue
        selected_drops.append((score, index))

    # The post-transition average makes a drop candidate robust but can place it
    # slightly late. Realign each candidate to the strongest local energy/bass
    # edge so a rendered impact lands on the transient itself.
    energy_step = np.maximum(np.diff(energy, prepend=energy[0]), 0.0)
    bass_step = np.maximum(np.diff(bass, prepend=bass[0]), 0.0)
    transition_edge = 0.55 * energy_step + 0.35 * bass_step + 0.10 * density
    aligned_drops: list[tuple[float, int]] = []
    align_back = int(round(0.8 * FEATURE_RATE_HZ))
    align_forward = int(round(0.2 * FEATURE_RATE_HZ))
    for score, index in selected_drops:
        search_start = max(1, index - align_back)
        search_end = min(len(frames), index + align_forward + 1)
        aligned_index = search_start + int(
            np.argmax(transition_edge[search_start:search_end])
        )
        if any(
            abs(aligned_index - kept_index) < cooldown_frames
            for _, kept_index in aligned_drops
        ):
            continue
        aligned_drops.append((score, aligned_index))

    for score, index in sorted(aligned_drops, key=lambda item: item[1]):
        peak_sec = float(times[index])
        # Promote a rise that leads into or spans the drop, and end it exactly
        # on the transient. Offline rendering can use this interval as lookahead.
        for cue in cues:
            cue_start = float(cue["startSec"])
            cue_end = float(cue["endSec"])
            if (
                cue["type"] in ("rise", "build")
                and cue_start < peak_sec
                and (cue_end >= peak_sec or peak_sec - cue_end <= 2.0)
            ):
                cue["type"] = "build"
                cue["endSec"] = round(peak_sec, 3)
                cue["peakSec"] = round(peak_sec, 3)
                cue["confidence"] = round(
                    _clip01(max(float(cue["confidence"]), 0.45 + 0.45 * score)),
                    4,
                )
        cues.append(
            {
                "type": "drop",
                "startSec": round(peak_sec, 3),
                "endSec": round(min(duration, peak_sec + 0.5), 3),
                "peakSec": round(peak_sec, 3),
                "intensity": round(_clip01(score), 4),
                "confidence": round(_clip01(0.45 + 0.50 * score), 4),
            }
        )

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


def main() -> int:
    if len(sys.argv) < 3:
        print(
            "usage: extract_events.py <audio_path> <output_json> [smart|beats|onsets]",
            file=sys.stderr,
        )
        return 2

    audio_path = sys.argv[1]
    output_path = sys.argv[2]
    mode = sys.argv[3] if len(sys.argv) > 3 else "smart"
    if mode not in ("smart", "beats", "onsets"):
        print(
            f"unknown mode '{mode}', expected 'smart', 'beats', or 'onsets'",
            file=sys.stderr,
        )
        return 2

    warnings.filterwarnings("ignore")

    import numpy as np
    import librosa

    reported_duration = float(librosa.get_duration(path=audio_path))
    if reported_duration > MAX_AUDIO_DURATION_SEC:
        print(
            f"audio duration {reported_duration:.1f}s exceeds the "
            f"{MAX_AUDIO_DURATION_SEC / 60:.0f}-minute analysis limit; split the input first",
            file=sys.stderr,
        )
        return 2

    y, sr = librosa.load(audio_path, sr=SAMPLE_RATE, mono=True)
    duration = float(librosa.get_duration(y=y, sr=sr))
    if duration > MAX_AUDIO_DURATION_SEC:
        print(
            f"decoded audio duration {duration:.1f}s exceeds the "
            f"{MAX_AUDIO_DURATION_SEC / 60:.0f}-minute analysis limit",
            file=sys.stderr,
        )
        return 2
    arrays = _analyze_arrays(y, sr)

    tempo_array, beat_frames = librosa.beat.beat_track(
        onset_envelope=arrays.percussive_onset,
        sr=sr,
        hop_length=HOP_LENGTH,
    )
    tempo = float(np.atleast_1d(tempo_array)[0]) if np.size(tempo_array) else 0.0
    beat_frames = np.asarray(beat_frames, dtype=int)
    beat_times = librosa.frames_to_time(beat_frames, sr=sr, hop_length=HOP_LENGTH)

    candidates = _build_candidates(mode, arrays, beat_frames, beat_times, sr)
    selected = _merge_candidates(candidates) if mode == "smart" else sorted(
        candidates, key=lambda item: item.time_sec
    )
    events = _events_from_candidates(selected, arrays)
    frames = _feature_frames(arrays, duration)
    section_cues = _detect_section_cues(frames, duration)

    result = {
        "version": 1,
        "durationSec": round(duration, 6),
        "tempo": round(tempo, 2),
        "mode": mode,
        "events": events,
        "featureFrames": frames,
        "sectionCues": section_cues,
    }
    with open(output_path, "w", encoding="utf-8") as output_file:
        json.dump(result, output_file, allow_nan=False, separators=(",", ":"))

    role_counts = {role: 0 for role in ROLES}
    for event in events:
        role_counts[event["role"]] += 1
    populated_roles = ",".join(
        f"{role}:{count}" for role, count in role_counts.items() if count > 0
    ) or "none"
    print(
        f"extract_events: mode={mode} events={len(events)} roles={populated_roles} "
        f"cues={len(section_cues)} tempo={tempo:.1f}bpm duration={duration:.1f}s",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
