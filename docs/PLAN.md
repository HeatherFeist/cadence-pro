# Cadence — Plan

## The core loop

1. **Bring your own text.** Paste text or upload a `.txt` file (more formats
   later — see Roadmap).
2. **Hear it set the tone.** Cadence reads the first 2-3 sentences aloud in a
   natural voice, so the reader hears the intended tone and pace before they
   start.
3. **Read along a pacing guide.** Hit Record. Words highlight left-to-right
   at a steady, adjustable pace (a metronome for reading, not a live listener
   trying to track you) — a "Narration Speed"-style slider controls how fast
   it moves, exactly like the pattern already proven out in Circle Squared.
4. **Fall behind? Reposition.** Pause. Click any word in the text to move the
   highlighter there. Hit Record again and keep going from that point.
5. **Get real feedback.** Once done, Cadence compares what was actually said
   (via live speech recognition running alongside the recording) against the
   real text — flagging skipped words, substitutions, and notably slow/halting
   spots.
6. **Hear it done right.** For each flagged word or phrase, tap it to hear a
   clean, correct reading of just that piece — not the whole document again.

## Why speech recognition runs *live*, not after the fact

The standard browser `SpeechRecognition` API listens to the live microphone
stream — it has no way to transcribe an already-recorded audio file. So
recognition runs **at the same time** as the `MediaRecorder` capture (both
attached to the same mic stream), not as a second pass afterward. The
recording itself is still kept, for playback/review, completely separately
from the transcript used for analysis.

## Real, deliberate technology choices (revisited from Circle Squared, not copied blind)

- **Speech-to-text ("listening"):** the browser's own built-in
  `SpeechRecognition` — free, zero setup, no separate model download. Real
  tradeoff, stated plainly: it leans on Google's/Apple's servers behind the
  scenes to do the actual transcribing, not fully private, not self-hosted.
  Chosen deliberately over an on-device model (e.g. Whisper) for now, given
  the real speed/download tradeoffs that surfaced building Circle Squared's
  Kokoro tier — revisit if that ever changes.
- **Text-to-speech ("the AI's own voice" and corrective playback):** the
  browser's native voice by default (same "Natasha"-then-"Google"-then-"Aria"
  preference pattern already proven out in Circle Squared) — free, instant,
  no lag. Because Cadence only ever needs to speak a few lines at a time (the
  opening, or one flagged phrase), a more natural voice tier is much more
  realistic to layer in later without hitting the lag problems that voice
  hit narrating whole multi-page readings.
- **Word-accuracy comparison:** a plain text-alignment/diff between the
  recognized transcript and the real text — mature, well-understood
  technique, no exotic dependency.
- **Pacing/confidence signal:** timing data already available for free from
  how long each recognized phrase took, without needing deep prosody
  modeling.

## What's explicitly NOT promised in v1

Real prosody/emphasis/emotional-delivery coaching is a hard, active area of
speech research — see the competitors researched for this project (Amira
Learning, Fonetti, Microsoft Reading Coach, ELSA Speak), all of which invest
heavily and specifically in this exact problem. v1 focuses on word accuracy,
skipped/substituted words, and pacing — genuinely useful, honestly scoped.

## What's different from the existing competitors

Most of the researched competitors (Microsoft Reading Coach, Amira, Fonetti)
work from their own pre-made story libraries, not text the user brings
themselves. Letting someone upload their *own* document — a speech, an
essay, an audition script, or a Circle Squared reading — is a real gap in
what's already out there.

## Roadmap (not v1)

- An adaptive layer that remembers a person's specific recurring mispronounced
  words across sessions (needs accounts + stored history — a real v2, not a
  quiet scope-creep addition to v1).
- File formats beyond plain text (PDF, DOCX, OCR for a photographed page).
- A Circle Squared integration: practice reading your own generated reading
  aloud.
