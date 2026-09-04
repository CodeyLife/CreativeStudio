# Cinematography Lexicon for H3 Storyboards

A working vocabulary for the Shot Equation (framing + composition + camera + light + colour + state change). All terms are genre-neutral; genre-specific visuals (energy wisps, runic glow) follow the same grammar and are adapted from the story's established visual system. Grammar rules for output structure are owned by the h3-prompt-writing skill; this file is the vocabulary layer.

Sections 2 (Composition) and 6 (Colour Design) are the picture-design layer. They decide whether a frame reads as designed or merely recorded, and they are the first place to look when output feels flat — framing, camera, light, and state change describe what happens in front of the lens, but composition and colour decide what the frame *is*.

## 1. Shot Sizes (framing)

| Term | Covers | Typical use |
| --- | --- | --- |
| extreme close-up (ECU) | A detail: an eye, a fingertip, a crack, a pulsing vein | Revelation, physiological stress, prop significance |
| close-up (CU) | Face or object fills most of the frame | Emotion, decision, dialogue emphasis |
| medium close-up (MCU) | Head and shoulders | Conversations, restrained reactions |
| medium shot (MS) | Waist up | Action with expression, blocking interactions |
| medium-wide (MWS) | Full body with surrounding space | Movement within a location |
| wide shot (WS) | Subject small within environment | Spatial context, isolation or scale |
| extreme wide / establishing (EWS) | Environment dominates | Opening a segment, geography, atmosphere |

Pair sizes with angles: eye-level (neutral), low-angle (power, threat, monument), high-angle (weakness, surveillance), overhead (fate, order), dutch (instability), over-the-shoulder (dialogue immersion), POV (subjective pressure).

## 2. Composition (picture design)

Where the subject sits and how the frame is built. This is the layer most often absent from a generated shot, and its absence is what reads as "flat".

- **Subject placement:** third-lines, edge, corner, dead-centre. Centre is a choice, not a default — it reads as menace, isolation, or standoff. Off-centre with weight on the negative space reads as pressure, pursuit, or exposure.
- **Foreground occlusion:** a doorway, branches, a hanging object, the shoulder or the back of another character's head. Produces a frame-within-the-frame, a darkened foreground slab, or a partial veil. Depth is the cheapest cure for flatness.
- **Lead-in lines:** a road, railing, stair edge, light shaft, river bank, or another character's gaze line, running toward the subject.
- **Layer separation:** foreground / midground / background each carrying something — never an empty middle.
- **Negative space:** give it a job — the thing that is coming, the thing that was lost, the scale of what dwarfs the subject.
- **Balance:** symmetry for order, ritual, or authority; deliberate imbalance for instability, pursuit, or collapse.
- **Level and horizon:** a level, centred horizon calms; a tilted or low horizon presses.

Anti-flat check: a bare medium shot — subject centred, no foreground occlusion, no lead-in line, no layer separation — is the video model's default render. Rewrite it.

## 3. Camera Behavior (H3 three-dimension grammar)

Motion type (from the H3 guide): push in / pull out / pan left / pan right / truck left / truck right / tilt up / tilt down / pedestal up / pedestal down / zoom in / zoom out / arc shot / tracking shot / static shot / shake slightly / shake strongly / roll clockwise / roll counterclockwise / POV.

Amplitude: `with small amplitude` / `with large amplitude`. Speed: `at slow speed` / `at fast speed`. Write as one natural sentence inside the shot; add amplitude and speed only when meaningful.

Working pairings that read as direction, not decoration:

| Intent | Expression |
| --- | --- |
| Discovery / focus | Push in (small amplitude, slow) toward a detail |
| Reveal of space | Pull out or pedestal up, from detail to geography |
| Following movement | Tracking shot along the subject's path |
| Disorientation / shock | Shake strongly, or dutch angle held while the camera pushes in |
| Transition inside a segment | Pan or truck that carries the cut's energy |
| Contemplation | Static shot while only light or focus changes |

A cut should introduce new information (subject, space, state, viewpoint, time). If only distance changes, prefer camera motion over a cut.

## 4. Light Design

Describe source, direction, quality, temperature:

- Sources: oil lamp, candle, window shaft, moonlight, fire, neon, screen glow, spiritual radiance.
- Direction/shape: backlit silhouette, rim light on hair and shoulders, side light carving texture, top light for pressure, light column through a broken roof.
- Dynamics: light that brightens with an energy build, dims to near-black before a reveal, flickers with a failing flame, or flashes white and washes out the background at a high-energy moment.
- Temperature contrast: warm interior against cold blue exterior; single warm source in a desaturated scene reads as hope or focus.

Highlights and shadows must carry a real falloff. Evenly spread light with no falloff produces no picture — it is the second default to rewrite.

## 5. Atmosphere and Particles

Atmospheric elements are cheap cinematic density — use what the scene honestly contains:

- Airborne: dust motes in a light column, drifting mist, smoke curls, steam, snow, rain streaks, floating embers, sparks.
- Surfaces: water ripples and reflections, wet stone sheen, condensation breath, frost creeping.
- Camera-optical: shallow depth of field with bokeh, motion blur on fast movement, lens flare against a source, slow rack focus between foreground and background.

## 6. Colour Design

One dominant colour and one accent colour per scene. Name them, name which element carries the accent, and say whether the accent contrasts or answers the dominant.

| Relationship | Reads as | Example |
| --- | --- | --- |
| Dominant + contrasting accent | Focus, threat, the thing that matters | blue-grey battlefield, one vermilion figure |
| Dominant + harmonic accent | Belonging, memory, warmth | amber interior, honey lamplight on skin |
| Warm dominant, cold accent | Intrusion, exile, the outside | warm room, cold blue window light |
| Colour shift across a turn | The turn itself, not decoration | a scene draining toward grey as a decision lands |

Rules:

- Grade words (desaturated, high-contrast, teal-and-amber, warm golden hour, cold blue night, washed-out pastel, heavy film grain, clean digital clarity) belong in the style line and stay consistent across segments of the same chapter unless the story changes them.
- Colour carries state, it is not a filter: it moves when emotion, time, or place moves. A scene holding one grade from setup through reversal has not used colour.
- A frame with no dominant/accent relationship is the video model's neutral default. Name the colours; "cinematic" and "tasteful grade" are not colour design.

## 7. Motion Emphasis (VFX grammar)

| Term | Shootable description |
| --- | --- |
| slow motion / overcranked | Actions stretched past natural speed at the peak: a fall, a turn, a drop of water |
| speed ramp | Normal speed snapping into slow motion at the impact instant |
| time freeze | Everything halts while one element continues (a flicker, a gaze) |
| particle build | Glowing particles gathering with rising intensity before a release |
| energy surge | Light or radiance escalating in brightness and scale toward a flash or burst |
| impact shock | A flash or boom followed by visible physical recoil of subjects and props |
| afterglow | The high-energy element fades, leaving a changed, quieter frame |

Stage the signature pattern when the prose offers a natural high point: build (escalating light/particles/sound) → peak (flash, impact, reveal) → shock reaction (physical recoil, flinch, stagger) → afterglow (a settled, changed frame). Do not fabricate spectacle the prose does not support.

## 8. Genre Visual Adaptation

Worldbuilding visuals (spirit-energy channels, runic glow, spell traces) are shot content, not abstract lore. Write them with the same grammar as physical light: colour, intensity, motion, onset, and where they appear on the body or in space — and keep them consistent with the shared visual system across segments. Abstract lore statements stay out of the storyboard; what the lens can see is what goes in.

Genre visuals are also subject to the picture-design layer: a glowing sigil is still a compositional element that occupies a position in the frame and carries a colour relationship to its surroundings.
