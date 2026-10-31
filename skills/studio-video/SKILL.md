---
name: studio-video
description: Use when the person wants a short video, reel, promo, explainer, slideshow or animated announcement. Plans a storyboard, then builds it from designed stills, voiceover and the video engine.
---

# Studio video

The `video` engine composes an MP4 from still images with motion (`still`, `zoom_in`, `zoom_out`, `pan_left`, `pan_right`), crossfades, a voiceover and music. It cannot draw text. Every word on screen comes from a still you render with the `design` engine.

## 1. Storyboard first

Write the storyboard as a short table before making anything:

| # | seconds | on screen (words and visual) | voiceover line | motion |
|---|---|---|---|---|

Rules of thumb:

- Shorts and reels run 15 to 30 seconds, 4 to 8 scenes, at 1080 x 1920. Landscape videos are 1920 x 1080.
- The first scene hooks within 1.5 seconds: a bold claim, a question, or the result first.
- One idea per scene, at most about 8 words on screen.
- Scene length follows its voiceover line: about 2.5 words per second, plus 0.4 seconds of breathing room.
- End on a clear call to action scene that holds for at least 2 seconds.

## 2. Voice before picture

When there is narration, make it first with the `voice` engine, one take for the whole script. Read its duration from the review, then fit scene durations so their sum minus transitions matches it within half a second. Load the studio-voice skill for script rules.

## 3. Stills

Render every scene with the `design` engine at the video's exact size. Use one shared style block so the scenes look like one piece. Load the studio-design skill. Keep text inside the safe area: away from the top 12% and bottom 18% on 9:16.

## 4. Compose

- `transition_s` is 0.3 to 0.6. Use 0 for hard cuts on beat-driven edits.
- Vary motion. Alternate zoom_in and pan, and keep text-heavy scenes `still` or gentle `zoom_in`.
- Add music only if the person provides a file or asks. Keep `music_volume` at 0.15 to 0.3 under a voiceover.

## 5. Review, fix, present

The review measures black or frozen frames, silence, loudness and peaks. Fix every `fail`. A `warn` about loudness or silence usually means the voiceover and scene timing drifted. Look at the middle-frame preview. Present the final video with `studio_present`, and include the storyboard as a short note in your reply.
