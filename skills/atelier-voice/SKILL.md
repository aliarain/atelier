---
name: atelier-voice
description: Use when making a voiceover, narration, spoken intro or audio read with the atelier voice engine. Script and voice rules for natural sounding text to speech.
---

# Atelier voice

The `voice` engine speaks text with the voices installed on this Mac and returns an M4A file. Call `atelier_engines` once to confirm it is available.

## Script rules

Text to speech sounds natural only when the script is written for the ear:

- Short sentences of 6 to 14 words. One idea each.
- Spell out what should be said: "twenty twenty six", "five dollars", "AI" as "A I" when it should be lettered.
- Use commas for small pauses and a new sentence for a real pause. No ellipses, emoji or markdown.
- Front-load the hook. The first sentence decides whether people keep watching.
- Read it at about 150 words per minute: 30 seconds is about 75 words.

## Voice choice

- Default `Samantha` for a clear US English voice. Try `Daniel` (British), `Karen` (Australian) or `Moira` (Irish) for variety.
- `rate` 170 to 190 suits ads and reels, 150 to 165 suits explainers.
- If the engine reports an unknown voice, pick one from the list it returns.

## After the take

The review reports duration, loudness and silences. A silence warning in the middle usually means a stray blank line or a very long pause in the script. Note the duration, because the video storyboard is timed from it.
