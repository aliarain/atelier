---
name: atelier-design
description: Use before making any poster, social post, thumbnail, slide, ad, cover or video still with the atelier design engine. Craft rules for HTML/CSS layouts that look professionally designed.
---

# Atelier design

The `design` engine renders your HTML in Chrome at an exact pixel size and returns a PNG plus a preview you can see. You are the designer. Treat every render as a real deliverable.

## Before the first render

Settle four things in one or two sentences:

1. **Format.** Pick the size from the table. Never guess.
2. **One message.** The single thing a viewer must get in two seconds.
3. **Hierarchy.** What the eye reads first, second and third.
4. **Palette and type.** Two or three colors with real contrast, one or two typefaces.

| Use | width x height |
|---|---|
| Instagram post (portrait) | 1080 x 1350 |
| Instagram square | 1080 x 1080 |
| Story, Reel, TikTok, Shorts frame | 1080 x 1920 |
| YouTube thumbnail, 16:9 slide, landscape video frame | 1920 x 1080 |
| X / LinkedIn card | 1200 x 675 |
| Poster (print-style preview) | 1240 x 1754 |

Use `scale: 2` only when the person needs a crisp export. Previews do not need it.

## Writing the HTML

- Send a full document. Set `html, body { margin: 0; width: <W>px; height: <H>px; overflow: hidden; }` so the canvas matches the render size exactly.
- Lay out with CSS grid or flexbox and real padding. Keep a safe margin of at least 6% of the short side. On 9:16 frames, keep text out of the top 12% and bottom 18%, where app UI sits.
- Typography carries most of the quality:
  - Use system families that exist on macOS: `"SF Pro Display", "Helvetica Neue", Helvetica, Arial, sans-serif`; `"New York", Georgia, serif`; `"SF Mono", Menlo, monospace`. Do not load web fonts.
  - Headlines are 7 to 12% of the canvas height, tight `line-height: 1.0 to 1.1` and slight negative `letter-spacing`.
  - Body text is never under 28px on a 1080-wide canvas.
  - Use `text-wrap: balance` on headlines.
- Color: one dominant, one accent, one neutral. Check contrast: light text on a busy or mid-tone area needs a scrim (`linear-gradient` overlay) behind it.
- Depth without clutter: one gradient, soft shadows (`0 30px 80px rgba(0,0,0,.35)`), rounded shapes, and SVG shapes or icons drawn inline.
- Images: reference earlier outputs by absolute `file://` path. For a photo look without a paid engine, build it from layered gradients, noise via SVG `feTurbulence`, and shapes.
- Write real copy. No lorem ipsum, no "Your text here", no placeholder brand names unless asked.

## After each render

Look at the preview before you say anything. Then check:

- Is the message readable at thumbnail size?
- Is anything clipped, overlapping, or touching an edge?
- Does the review return a `blank` or `dimensions` problem?
- `atelier_create` also reports layout issues (clipped text, off canvas, overlap, safe area, tight edges). Fix every one before presenting.

Fix and render again. Two or three iterations is normal. Name versions in the title ("Launch poster v2") so the gallery tells them apart.

When a set is needed (carousel, story sequence, video stills), keep one CSS block of shared tokens (colors, type scale, margins) and vary only the content, so the set looks like one system.

Present the final with `atelier_present` and a one-line note.
