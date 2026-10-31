---
name: atelier-video
description: Use when the person wants a short video, reel, promo, explainer, slideshow or animated announcement. Plans a storyboard, then builds it from designed stills, voiceover and the video engine.
---

# Atelier video

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

When there is narration, make it first with the `voice` engine, one take for the whole script. Read its duration from the review, then fit scene durations so their sum minus transitions matches it within half a second. Load the atelier-voice skill for script rules.

## 3. Stills

Render every scene with the `design` engine at the video's exact size. Use one shared style block so the scenes look like one piece. Load the atelier-design skill. Keep text inside the safe area: away from the top 12% and bottom 18% on 9:16.

## 4. Compose

- `transition_s` is 0.3 to 0.6. Use 0 for hard cuts on beat-driven edits.
- Vary motion. Alternate zoom_in and pan, and keep text-heavy scenes `still` or gentle `zoom_in`.
- Add music only if the person provides a file or asks. Keep `music_volume` at 0.15 to 0.3 under a voiceover.

## 5. Review, fix, present

The review measures black or frozen frames, silence, loudness and peaks. Fix every `fail`. A `warn` about loudness or silence usually means the voiceover and scene timing drifted. Look at the middle-frame preview. Present the final video with `atelier_present`, and include the storyboard as a short note in your reply.

## Motion

The `motion` engine renders an HTML page with CSS keyframes, the Web Animations API, SVG animation or `requestAnimationFrame` to an MP4. It plays the page on a virtual clock, one frame at a time, so the result is exact whatever the machine speed. Use it instead of stills plus camera moves when the picture itself must move: kinetic typography, animated titles, logo reveals, animated charts, lower thirds. Keep the `video` engine for photo or poster stills with a slow zoom or pan.

Rules:

- Build the animation with CSS keyframes or the Web Animations API on one timeline that ends before `duration_s`. Time starts at 0 when the page loads, so do not wait on real events or the network.
- Put about 60% of the motion in the first and last 20% of each beat. Let things settle in between.
- Ease out for entrances and ease in for exits.
- Hold the final frame for 1 second so the last text can be read.
- Keep text inside the safe area: away from the top 12% and bottom 18% on 9:16.
- Size the clip to the target (`width` x `height`, 1080 x 1920 for reels) and choose `fps` 30 unless the person wants a filmic 24.
- A motion clip cannot yet be one scene of a larger edit, because the `video` engine only takes stills. Make each motion piece complete on its own: opening, payoff, and closing hold. Add `voiceover` or `music` straight to the motion call when sound is needed.
