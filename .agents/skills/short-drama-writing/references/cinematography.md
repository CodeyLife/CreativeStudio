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

### 2.1 The vertical frame

The vertical frame is a depth instrument, not a cropped horizontal one; every tool above has a vertical-native reading:

- **Vertical layering:** foreground occluders hang from the top edge (a door frame, branches, rain curtains, suspended objects) and close the frame's upper third; lead-in lines run vertically — corridors, stair shafts, light columns, a gaze tilting up or down the frame.
- **Camera height does more work:** low angles turn a figure's height into power and scale against the tall frame; high angles compress the subject into the lower band, small and exposed. Dutch tilt reads vertically — the world sliding.
- **Faces carry the story:** a close-up fills a vertical frame's width, so micro-expression is the close-up grammar. Reserve the top band for headroom or a hanging element and the bottom band for hands, props, and foreground texture; the subject's eyes sit near the upper third-line.
- **Two-person blocking:** side-by-side pairs crowd a vertical frame. Prefer depth blocking (one figure behind the other, foreground back turned), or alternate singles (over-the-shoulder, POV) so each face gets the frame's width.
- **Compose for it, don't name it:** the ratio and the words "vertical/horizontal frame" never appear in the script text — orientation is a generation parameter, and a prompt that declares it has described the container rather than the picture. Everything above is how the vertical frame reaches the render: through where subjects sit, what hangs from the top edge, which way the lines run, and how high the camera sits.

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

## 9. The Standalone Visual Short (lens-aesthetics mode)

A tens-of-seconds piece with no plot to carry is a single aesthetic statement shot by shot. Its beats are camera beats, not story beats. This section is the *camera-art* half of a standalone short; the *engine* half — which attention engine the piece commits (awe / humor / conflict), its one subversion and one signature frame — is designed first, in `attention-hooks.md`.

- **One signature subject.** One visual subject or image owns the piece — every shot is a new way of seeing it (approach, scale step, detail, revelation), never a new topic. Subject definitions and the style line are built around it; atmosphere elements only dress it. The subject is a deliberate carrier choice (megastructure, celestial body, living colossal, frozen phenomenon, spatial-law anomaly — `attention-hooks.md`), not the archetype's most famous symbol; keep one human or human-scale reference in frame so the excess stays measurable.
- **One aesthetic idea.** One lighting system plus one dominant/accent colour relationship, declared in the style line and held across the piece; variation comes from intensity, state change, and progression — not from switching palettes mid-piece.
- **Progression is the spine.** Beats are visible steps of scale, depth, or revelation — near to far, small to vast, surface to interior. Each shot must advance the progression one step; a shot that repeats the previous step is filler, however beautiful.
- **Prefer the long take.** Continuous spatial movement rides a single shot with multi-stage camera movement (push through, ascend past, descend into); cut only for necessary viewpoint or subject changes. One continuous 10-15s shot that travels beats a three-shot montage that hops.
- **Atmosphere is connective tissue.** Particles, mist, reflections, drifting light carry continuity between shots and are the cheapest cinematic density — but they dress the signature subject; they never become the subject.
- **Exit on the strongest frame.** The final shot is the most complete revelation of the signature subject — the piece ends on an image, not on a summary or a settled afterglow.
