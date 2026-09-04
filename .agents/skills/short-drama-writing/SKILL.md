---
name: short-drama-writing
description: Direct high-quality short-drama storyboards from novel chapters or a core creative idea into MiniMax H3 Ref2VA six-section prompts with 5-10s segment budgeting, opening hooks, emotion cadence, and cliffhanger cut points. Use when adapting committed chapter prose into shot-by-shot video prompt scripts, when creating a short standalone script (e.g. a Douyin-style vertical short video) from a single creative idea, when planning beat coverage and shot rhythm, when designing episode-level hooks and segment exits, when choosing camera language (shot sizes, angles, camera motion, lighting, VFX), or when reviewing whether a generated storyboard reaches cinematic density. Covers the directing and dramaturgy layers; the output grammar (six-section structure, speaker IDs, <d> tags) is defined by the h3-prompt-writing skill.
compatibility: Portable to any agent that can read local files. Complements h3-prompt-writing (grammar) — this skill supplies the directing layer (what to shoot and how to make it cinematic) and the dramaturgy layer (hooks, emotion cadence, cut points).
metadata:
  trigger-words:
    - 短剧剧本
    - 分镜剧本
    - 剧本提示词
    - 镜头语言
    - 抖音短剧
    - 创意短剧
    - storyboarding
    - shot list
    - cinematic storyboard
---

# Short Drama Writing

Direct committed novel chapters — or a single core creative idea — into short-drama storyboard scripts that a video model can actually shoot. The grammar of the output (Ref2VA six sections, `[Shot N]` markers, `<d>` dialogue tags, speaker IDs) is owned by the **h3-prompt-writing** skill; this skill owns the **directing layer** — what each shot should contain, how shots should rhythm, and how to reach cinematic density instead of plot summary.

Two entry modes share the same directing and dramaturgy layers:

- **Chapter mode** — adapt committed chapter prose; the prose is the single source of facts and dialogue semantics.
- **Idea mode** — build a standalone short script (10-180s, e.g. a Douyin-style vertical short) from one core creative idea; the idea must state who, where, and what conflict, and the beats are designed rather than extracted.

Core principle: **A storyboard is not a plot retold in English — it is a shootable sequence of framed moments, each with a lens, a camera, a light, and a sound.** A beat that only says what happens ("he wakes up") is a summary; a beat that says how the camera sees it happen is a shot.

## Start Gate

Before writing any shot, confirm these inputs are in hand. If any is missing, stop and gather it:

1. **Mode and source** — chapter mode requires committed chapter prose (the single source of facts, causality, and dialogue semantics); idea mode requires the core creative idea with who / where / what-conflict stated, plus a target duration (10-180s; default 30s).
2. **Beat list** — chapter mode: an exhaustive enumeration of the chapter's story beats (event / dialogue / memory / setup / hook / decision), each with its concrete information points (who, where, what). Idea mode: a designed beat sequence that opens inside the conflict and ends on a cut point.
3. **Shared subject definitions** — if a preset library exists (characters, environments, props already defined by the author), new segments reuse those labels verbatim and never redefine them; only genuinely new subjects get new definition lines, numbered after the shared maximum.
4. **Segment budget** — segments of 5-10 seconds each; chapter mode derives the segment floor from prose length (~350 CJK characters per segment is the working budget); idea mode derives it from target duration. Every information-carrying beat must land in some segment.

## Operating Principles

1. **Coverage beats compression.** Every beat carrying plot information (memories, setups, deadline hooks, belief shifts) must appear in some segment. Background material is never silently dropped — it is presented through flashback shots, spoken dialogue (including off-screen voiceover), or on-screen text.
2. **Reaction is not presentation.** Clutching the head, trembling, and gasping only express that *something* arrived. The content itself (a identity, an obligation, a rule of the world) must be shown: flashback frames that depict who did what where, spoken lines that state the information, or readable on-screen text.
3. **Dialogue stays faithful.** Spoken content preserves the original language and the fact/causal semantics of the prose; compression is allowed, rewriting facts is not. Dense dialogue prioritizes the complete spoken timeline over word-count targets.
4. **One main action per shot.** Secondary elements enter with slight delay and never compete for the same attention window.
5. **Peaks and brakes.** A 5-10s segment carries one rhythm peak (action completion, reveal, impact) and one braking moment (a held close-up, a readable line, a settle). Open with an establishing beat, land on an exit that pulls the viewer to the next segment.
6. **Rhythm vocabulary:** setup → establish → prepare → impact → brake → settle. Label the intent of each shot mentally before writing it.
7. **Signature moments are sought, not forced.** When the prose offers a natural high point (an energy surge, a collapse, a reveal), stage it as a signature shot: an escalating light or VFX build, a high-energy moment, a physical shock reaction, then an afterglow. Do not invent spectacle the chapter does not contain.
8. **Shared subjects are referenced, never restated.** Redefining a shared subject inside a segment is a fidelity violation.

## Short-Drama Dramaturgy (Episode Layer)

The segment contract above is the unit; the episode is the product. Full detail in `references/dramaturgy.md`; the load-bearing rules:

1. **Open inside the conflict.** The first segment's peak lands within its opening seconds; the core clash, who-opposes-whom, and the protagonist's immediate goal are visible or spoken within roughly the first 10 seconds of the episode. Context arrives later via presentation channels, never as an opening slow build.
2. **Emotion cadence: one node every 2-4 segments** (20-30s at the 5-10s budget) — a dialogue clash, action clash, or information reveal. Three consecutive segments without a node is a cadence failure. The first small reversal lands within the first third of the episode.
3. **Exits are hooks; cut on the impact point.** Each segment's exit state raises a question or the stakes; the episode's final segment cuts at the instant of reveal/contact/decision, not after it settles — viewers leave hungry, not satisfied.
4. **Dialogue density.** Every spoken line confirms identity, ignites conflict, or states consequence; filler lines are compressed out. Key beats stay readable with sound off (faces, actions, on-screen text).
5. **Reversals need plants.** Every reversal traces to a beat presented earlier via an insert shot, spoken line, or readable detail (plant → overlook → detonate). No plant in the prose, no reversal.
6. **Character economy.** A core triangle per episode (protagonist / opponent / helper); each character reads as label + contrast + secret, anchored by a shared-subject visual constant.

## The Shot Equation

Every `[Shot N]` should answer six questions at once. Framing, camera, light, and state change describe *what happens in front of the lens*. Composition and colour are the **picture-design layer** — they decide whether a frame looks designed or merely recorded. Composition and colour are also the largest single source of "flat, forgettable" output, because centred framing and undifferentiated colour are exactly what a video model renders by default when the prompt does not specify otherwise.

1. **Framing (shot size + angle):** extreme close-up / close-up / medium close-up / medium shot / medium-wide / wide / extreme wide; eye-level, low-angle, high-angle, overhead, dutch, over-the-shoulder, POV.
2. **Composition (picture-design layer):** where the subject sits in the frame and how the frame is structured — third-lines / edge / corner / dead-centre (centre needs a reason: menace, isolation, standoff); foreground occlusion (a doorway, branches, an object, another character's shoulder — a frame-within-the-frame or a darkened foreground layer); lead-in lines (a road, a railing, a light shaft, a gaze line pointing at the subject); foreground / midground / background separation; what the negative space is doing; symmetry or deliberate imbalance.
3. **Camera behavior:** the H3 three-dimension grammar — motion type (push in / pull out / pan / truck / tilt / pedestal / zoom / arc / tracking / static / shake / roll), amplitude, speed — written as one natural English action, not stacked labels.
4. **Light and atmosphere:** source (lamp, window, moon, fire, neon), direction (backlit, rim-lit, side-lit, top-lit), quality (hard/soft), color temperature, and atmospheric elements (dust motes, drifting mist, rain streaks, floating embers, steam). Highlights and shadows must carry a real falloff — flat, evenly spread light produces no picture.
5. **Colour design (picture-design layer):** one dominant colour and one accent colour per scene; name which element carries the accent and whether it contrasts or answers the dominant (a single vermilion figure in a blue-grey battlefield; cold blue window light in a warm amber room). Colour shifts with emotional turns and with time/space changes. Writing "cinematic" or "tasteful grade" without naming a concrete colour relationship is no colour design at all.
6. **State change:** what visibly changes during the shot — position, expression, object state, light level, colour — ending in a state the next shot can inherit.

Aim for all six in every shot; a deliberate static shot is acceptable but must still name its framing, composition, and light.

**Anti-flat defaults.** These four are what a video model renders when the prompt does not specify otherwise. Self-check every shot and rewrite on a hit:

- **Bare medium shot** — subject dead-centre, no foreground occlusion, no lead-in line, no layer separation.
- **Flat light** — evenly spread, no highlight/shadow falloff.
- **Neutral frame** — no dominant/accent colour relationship.
- **Constant-speed motion** — no velocity contrast across the shot.

A full style line precedes `[Shot 1]`, specific enough to reconstruct: aspect ratio and focal feel (2.39:1 anamorphic, vertical 9:16 wide-angle), medium (film grain / clean digital), lighting system (single hard source with chiaroscuro falloff / soft diffusion), colour base (teal-amber contrast, desaturated cold with one warm source), and era tone. "Live-action cinematic" is not a style line.

## Genre Visual Effects

Worldbuilding elements that are *visible* in the story (glowing energy channels, floating runic light, spirit wisps, spell traces) are shootable picture information — write them concretely (color, motion, intensity, where they appear on the body or in space). This is the visual layer, distinct from narrative-language rules that govern prose; in a storyboard, what the camera can see is exactly what must be written. Keep genre effects consistent with the established visual system across segments.

## Sound Picture

- `overall_soundscape`: ambience and physical action sounds only; per-shot synchronized sounds stay in the description.
- `non_diegetic_music`: audience-only score with instrumentation, tempo, and dynamic development; describe how it swells against picture moments and where it cuts or fades. Sound-picture alignment (a swell peaking at the impact, a sudden silence after the flash) is part of the cinematic effect.

## Workflow

1. Enumerate beats with concrete information points; map every beat to a segment; mark beats that can serve as plants for later reversals.
2. Plan the episode layer: opening hook segment, emotion-node placement (one per 2-4 segments), first reversal, and the cliffhanger cut point (see references/dramaturgy.md).
3. For each segment, choose a rhythm pattern (which shot is the peak, which is the brake, what the exit hook is).
4. Write shots with the full Shot Equation; place dialogue via stable speaker IDs; use `[Flashback]` framing for memory material.
5. Assemble the six sections in order; the subject-definitions section carries only subjects new to this segment.
6. Run the quality checklist (see references/quality-checklist.md); fix what it flags before delivery.

## Failure Handling

- Beat missing from all segments → re-enumerate and re-map; information blocks are never dropped.
- A shot reads as plot summary → rewrite with the Shot Equation; a sentence without a lens, a composition, or a light is not yet a shot.
- A shot hits an anti-flat default (centred bare medium shot, flat even light, neutral frame, constant-speed motion) → rewrite the offending variable rather than adding detail elsewhere.
- Segment flat (no peak) → find the prose's strongest change inside it and stage that as the peak; if truly static, make the brake deliberate (a held detail shot) and let an adjacent segment carry the peak.
- Episode opens with routine/scenery → start on the brink of the chapter's first clash; backfill context through presentation channels.
- Emotion cadence broken (3+ segments without a node) → redistribute peaks so a clash or reveal lands every 2-4 segments; add brakes, not filler.
- Episode ends settled instead of hooked → move the cut to the impact instant; let the reveal open the next episode.
- Reversal without an earlier plant → insert the plant via a presentation channel in an earlier segment, or drop the reversal.
- Shared subject redefined → delete the line and reference the shared label.
- Timing drifts past duration → recompute cut points; the last cut must leave time for the action to land.
- Genre effects described abstractly → replace with visible, concrete, shootable wording (color, motion, location on body/space).

## Trigger Examples

Use this skill for: adapting a finished chapter into storyboard prompts (the CreativeStudio MCP tool `novel_chapter_script_h3`); creating a standalone short script from one core idea, e.g. a Douyin-style short video (the MCP tool `novel_short_script_h3`, which takes `idea` + optional `instruction` + `targetDurationSeconds`); reviewing whether a generated storyboard is cinematic enough; planning beat-to-segment coverage; designing episode-level hooks, emotion cadence, and cliffhanger cut points; choosing camera and lighting language for a scene; staging a signature moment.

Not for: the six-section output grammar itself (use h3-prompt-writing), prose-level novel writing (use novel-writing), or video model API parameters.
