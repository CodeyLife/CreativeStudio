---
name: short-drama-writing
description: Translate committed novel chapters — or a single core creative idea — into MiniMax H3 Ref2VA six-section storyboard prompts. The skill's centre of gravity is camera art — framing, composition, camera behavior, light, colour, and state change in every shot, at a 10-15s segment budget. It never creates story — chapter mode converts already-committed plot into shot language (a thin dramaturgy overlay only decides where to open, which information must reach the frame, and where to cut); idea mode builds a tens-of-seconds short (~10-180s) by first committing one attention engine — awe (the sublime), humor (incongruity played straight), or conflict when the idea itself states one — plus a single subversion and one signature frame every beat builds or detonates, no connected plot required. Use when adapting committed chapter prose into shot-by-shot video prompt scripts, when creating a short standalone script (e.g. a Douyin-style vertical short video) from a single creative idea, when brainstorming hook engines for a weak idea, when planning beat coverage and shot rhythm, when choosing camera language (shot sizes, angles, camera motion, lighting, VFX), when designing visual-aesthetic shorts (signature imagery, scale progression, single long takes), when engineering comedic shorts (mismatch, deadpan, setup-payoff timing), or when reviewing whether a generated storyboard reaches cinematic density. Covers the directing and dramaturgy-overlay layers; the output grammar (six-section structure, speaker IDs, <d> tags) is defined by the h3-prompt-writing skill.
compatibility: Portable to any agent that can read local files. Complements h3-prompt-writing (grammar) — this skill supplies the camera-art layer (what the lens sees and how the frame is designed) plus a thin dramaturgy overlay (open/coverage/cut decisions over material whose story is already fixed or not needed).
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

Translate committed novel chapters — or a single core creative idea — into short-drama storyboard scripts that a video model can actually shoot. The grammar of the output (Ref2VA six sections, `[Shot N]` markers, `<d>` dialogue tags, speaker IDs) is owned by the **h3-prompt-writing** skill. This skill's centre of gravity is the **camera art**: what each shot contains, how the frame is designed, and how to reach cinematic density instead of plot summary. It never creates story — in both modes the story is either already fixed or not needed, and the dramaturgy layer is a thin selection-and-cut overlay, not a plotting device.

Two entry modes, both camera-art first:

- **Chapter mode** — the plot, characters, and dialogue already exist in committed prose (the single source of facts and dialogue semantics). The job is pure translation into shot art: choose the frames, design composition, light, and colour, present every information beat visually, and cut where the material's own tension peaks. No plotting happens here.
- **Idea mode** — a tens-of-seconds standalone short (10-180s, e.g. a Douyin-style vertical short) built from one core creative idea; **no connected plot is required**. Before writing any shot, commit one **attention engine** and the creative strategy around it (full mechanism lists in `references/attention-hooks.md`): **awe** (the sublime — one signature visual subject, spatial/scale progression, light and atmosphere as the beats, single long-take camera work, exits on the strongest frame), **humor** (incongruity — a named mismatch played straight, setup → payoff beats, the punchline landed as a visible frame with a deadpan reaction shot; see `attention-hooks.md`), or **conflict** (only when the idea itself states a character conflict — present that situation as visual tension: the confrontation, the contrast, the action instant, never developed into plot; driving-level contract in `short-drama-autopilot`; runtime contract in the pipeline's short.script skill). Whatever the engine, the piece commits **one subversion** of the viewer's template expectation and **one signature frame** every beat either builds or detonates; the piece exits on that frame.

Core principle: **A storyboard is not a plot retold in English — it is a shootable sequence of framed moments, each with a lens, a camera, a light, and a sound.** A beat that only says what happens ("he wakes up") is a summary; a beat that says how the camera sees it happen is a shot.

## Start Gate

Before writing any shot, confirm these inputs are in hand. If any is missing, stop and gather it:

1. **Mode and source** — chapter mode requires committed chapter prose (the single source of facts, causality, and dialogue semantics); idea mode requires the core creative idea — a subject/scene worth showing, or a situation with who/where/what-tension — plus a target duration (10-180s; default 30s). For open-ended directions, first diverge candidates across engines (the pipeline tool `novel_short_script_h3_brainstorm` returns hook-typed wonders that avoid recently used motifs) and commit one.
2. **Beat list** — chapter mode: an exhaustive enumeration of the chapter's story beats (event / dialogue / memory / setup / hook / decision), each with its concrete information points (who, where, what). Idea mode: a **creative strategy first** (engine + one subversion + one signature frame, `references/attention-hooks.md`) and then a designed beat sequence organized around that strategy — visual progression for awe, mismatch/beat-down timing for humor, situation-tension presentation for conflict ideas — ending on the strongest frame.
3. **Shared subject definitions** — if a preset library exists (characters, environments, props already defined by the author), new segments reuse those labels verbatim and never redefine them; only genuinely new subjects get new definition lines, numbered after the shared maximum.
4. **Segment budget** — segments of 10-15 seconds each (aligned with the runtime pipeline contract; spectacle and impact beats take the upper edge, dialogue exchanges still fill at least 10 seconds with detail, never filler); chapter mode derives the segment floor from prose length and information density; idea mode derives it from target duration. Every information-carrying beat must land in some segment.

## Operating Principles

1. **Coverage beats compression.** Every beat carrying plot information (memories, setups, deadline hooks, belief shifts) must appear in some segment. Background material is never silently dropped — it is presented through flashback shots, spoken dialogue (including off-screen voiceover), or on-screen text.
2. **Reaction is not presentation.** Clutching the head, trembling, and gasping only express that *something* arrived. The content itself (a identity, an obligation, a rule of the world) must be shown: flashback frames that depict who did what where, spoken lines that state the information, or readable on-screen text.
3. **Dialogue stays faithful.** Spoken content preserves the original language and the fact/causal semantics of the prose; compression is allowed, rewriting facts is not. Dense dialogue prioritizes the complete spoken timeline over word-count targets.
4. **One main action per shot.** Secondary elements enter with slight delay and never compete for the same attention window.
5. **Peaks and brakes.** A 10-15s segment carries one rhythm peak (action completion, reveal, impact) and one braking moment (a held close-up, a readable line, a settle). Open with an establishing beat, land on an exit that pulls the viewer to the next segment.
6. **Rhythm vocabulary:** setup → establish → prepare → impact → brake → settle. Label the intent of each shot mentally before writing it.
7. **Signature moments are sought, not forced.** When the prose offers a natural high point (an energy surge, a collapse, a reveal), stage it as a signature shot: an escalating light or VFX build, a high-energy moment, a physical shock reaction, then an afterglow. Do not invent spectacle the chapter does not contain.
8. **Shared subjects are referenced, never restated.** Redefining a shared subject inside a segment is a fidelity violation.
9. **One subversion, one signature frame (idea mode).** Before beats, commit the creative strategy — one engine (`awe` / `humor` / `conflict`), **one subversion** of what the viewer's template expectation predicts by the third second, **one signature frame** (a 3-5s moment retellable in one sentence) that every beat either builds or detonates, and the piece exits on it or its immediate aftershock. Multiple equal signature frames means none. The reversal lands as a visible state change in a frame, never as a spoken announcement. Engine mechanism lists (awe carriers, the three mismatch types, played-straight discipline, setup→payoff beat patterns, the punchline-in-shot rule, music/picture incongruity, cross-work anti-recurrence) live in `references/attention-hooks.md`; the runtime pipeline carries the same contract as `creativeStrategy` + the short.script skill's 吸引力设计契约.

## Dramaturgy Overlay (selection & cut points — not story creation)

The story is given (chapter mode) or reduced to a situation (idea mode); this layer only decides where to open, which information must reach the frame, and where to cut — every device below is a check that the material's own drama is fully carried into frames, never a licence to invent drama. Full detail in `references/dramaturgy.md`; multi-episode series-level rhythm in `references/serial-rhythm.md` (serialized runs only, never a single 10-180s short); the load-bearing rules — all of them **scale with the piece's segment count**: a 1-2 segment micro short carries only *open inside the tension → one beat → strongest sting*, and rotation, plant-distribution, and escalation devices bind only when the piece is long enough to hold them (scale table in `dramaturgy.md` §0):

1. **Open inside the conflict** *(conflict material only — chapter mode, and idea modes whose idea states a tension; spectacle pieces instead open on their most striking image, see cinematography.md §9)*. The first segment's peak lands within its opening seconds; the core clash, who-opposes-whom, and the protagonist's immediate goal are visible or spoken within roughly the first 10 seconds of the episode. Context arrives later via presentation channels, never as an opening slow build.
2. **Emotion cadence: one node every 2-4 segments** (20-60s at the 10-15s budget; conflict material — a spectacle piece's beats are progression steps, not nodes) — a dialogue clash, action clash, or information reveal. Three consecutive segments without a node is a cadence failure. The first small reversal lands within the first third of the episode. The node works the **suppression → release** loop, and the loop is scale-invariant — even a 15-second clip can raise stakes in a couple of seconds and pay them off once — but multi-release **rotation** binds only where the segment count carries more than one release: shorter pieces spend their single release on the strongest pressure and never pad toward it.
3. **Exits are hooks; cut on the impact point.** Each segment's exit state raises a question or the stakes; the episode's final segment cuts at the instant of reveal/contact/decision, not after it settles — viewers leave hungry, not satisfied. The five generic hook types — identity suspense (an answer about to surface), expectation reversal (the frame overturns what was assumed), emotional suspension (cut at the peak feeling, before its release), half-revealed information (only part of a state-changing fact shown), and incoming crisis (danger or deadline suddenly live) — are a vocabulary for *choosing* each exit; rotating across consecutive exits binds only where the piece has enough exits to repeat a type at all.
4. **Dialogue density.** Every spoken line confirms identity, ignites conflict, or states consequence; filler lines are compressed out. Key beats stay readable with sound off (faces, actions, on-screen text). The line that carries a beat's peak lands **on the shot that shows it** (the line fires against the image that reveals it — a declaration against its triggering visual, a demand against the thing demanded), never across the cut that leads to it.
5. **Reversals need plants.** Every reversal traces to a beat presented earlier via an insert shot, spoken line, or readable detail (plant → overlook → detonate). No plant in the prose, no reversal.
6. **Character economy** *(conflict material)*. A core triangle per episode (protagonist / opponent / helper); each character reads as label + contrast + secret, anchored by a shared-subject visual constant.

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

A full style line precedes `[Shot 1]`, specific enough to reconstruct: focal feel (anamorphic wide-angle perspective, long-lens compression, macro shallow focus), medium (film grain / clean digital), lighting system (single hard source with chiaroscuro falloff / soft diffusion), colour base (teal-amber contrast, desaturated cold with one warm source), and era tone. "Live-action cinematic" is not a style line.

**The style line never names the aspect ratio or the orientation** — no ratio digits, no "vertical frame" / "horizontal frame" wording, neither in the style line nor anywhere else in the script. The deliverable's ratio is a generation parameter: stating it in prompt text changes nothing on screen and spends the segment's scarcest resource — reading time — restating the container. The cost is multiplied by the reuse rule: in the pipeline the style line is planned once and then copied verbatim into every segment, so one ratio written there reappears in all of them. Orientation is still a real design constraint; it is carried by the shot instead — vertical layering, foreground hanging from the top edge, vertical lead-in lines, camera height doing the scale work, faces filling the frame's width (`references/cinematography.md` §2.1).

## Genre Visual Effects

Worldbuilding elements that are *visible* in the story (glowing energy channels, floating runic light, spirit wisps, spell traces) are shootable picture information — write them concretely (color, motion, intensity, where they appear on the body or in space). This is the visual layer, distinct from narrative-language rules that govern prose; in a storyboard, what the camera can see is exactly what must be written. Keep genre effects consistent with the established visual system across segments.

## Sound Picture

- `overall_soundscape`: ambience and physical action sounds only; per-shot synchronized sounds stay in the description.
- `non_diegetic_music`: audience-only score with instrumentation, tempo, and dynamic development; describe how it swells against picture moments and where it cuts or fades. Sound-picture alignment (a swell peaking at the impact, a sudden silence after the flash) is part of the cinematic effect.

## Time Budget (beats / shots / voice)

The 10-15s segment is the scarcest resource; before writing shots, budget it across three layers that all draw from the same time pool:

1. **Beat layer:** a segment carries one main beat (1-3 beats is the normal range). Overloading beats does not present information — split into another segment or compress into a neighbour instead of shrinking every shot proportionally.
2. **Shot layer:** each shot needs time to complete its action and camera move — segment duration ÷ shot count is the per-shot budget. A 10-15s segment normally holds 2-3 shots (no more than ~3 cuts); below ~3s per shot, merge shots or switch to a single shot with staged camera moves. Carry long dialogue on a sustained camera move (voice-over over sustained shot) so speech and image breathe together.
3. **Voice layer (spoken-line conservation):** dialogue is audio on a timeline, not a free annotation — Chinese at roughly 4-5 characters per second, English at 2.5-3 words per second. The segment's total spoken time (voiceover included) must not exceed the segment duration (overrun is physically undeliverable; the generator can only truncate or rush it), and roughly a fifth of the segment stays reserved for reaction and visual breathing. When lines overrun, compress them (keep the information points and causal semantics) or hand them to a neighbouring segment; dialogue-dense beats deserve 12-15s segments. A dialogue-free segment must be a self-sufficient picture design (environmental performance, readable on-screen text, atmosphere beat) — never dead air.

## Workflow

1. (Idea mode only) Commit the creative strategy: engine + one subversion + one signature frame; check the subversion is not what the archetype's default symbols would have produced (`references/attention-hooks.md`). Then enumerate beats with concrete information points; map every beat to a segment. Episode-regime pieces additionally mark plant beats and assign exit hook types (see references/dramaturgy.md §0 for when these devices bind).
2. Plan the overlay for pieces long enough to carry it: opening segment inside the material's tension, node placement, and the cut point (see references/dramaturgy.md); micro/short standalone pieces skip to step 3 with one main beat and one exit.
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
- Emotion cadence broken (3+ segments without a node; episode-regime pieces) → redistribute peaks so a clash or reveal lands every 2-4 segments; add brakes, not filler.
- The previous segment's hook is ignored → open the next segment acknowledging it (the answer may open new questions but must give new information); an unanswered hook reads as broken trust.
- Same hook or release type repeats three exits in a row (pieces long enough to repeat) → rotate to a different type and escalate intensity instead of repeating; repetition breeds immunity.
- Episode ends settled instead of hooked → move the cut to the impact instant; let the reveal open the next episode.
- Reversal without an earlier plant → insert the plant via a presentation channel in an earlier segment, or drop the reversal.
- Shared subject redefined → delete the line and reference the shared label.
- Spoken lines exceed the segment's speech budget (speech time > segment duration) → compress the lines (keep information points and causal semantics) or move them to a neighbouring segment; prefer handing dialogue-dense beats a 12-15s segment.
- A dialogue-free segment reads as dead air → redesign it as a self-sufficient picture (environmental performance, readable on-screen text, atmosphere beat) or give it spoken/voiceover content.
- Timing drifts past duration → recompute cut points; the last cut must leave time for the action to land.
- Genre effects described abstractly → replace with visible, concrete, shootable wording (color, motion, location on body/space).
- (Idea mode) Every picture predictable from the opening → the subversion was never committed or never landed as a frame: name what the first seconds make the viewer expect, then design the one beat that overturns or escalates it visibly (or, for humor, the one escalation where the mismatch detonates — never announced, never merely spoken).
- A punchline or reveal exists only in dialogue lines → move it into the picture: the line lands on the shot showing its payoff, followed by a deadpan reaction frame.
- Several equal "strongest frames" compete for the signature slot → keep one, demote the rest to buildup; multiple signature frames means none.
- The concept collapses onto the archetype's default spectacle (the setting's most famous symbol, or the most obvious scale gimmick) → re-run the derivation: keep the theme, change the material/geometry/spatial law or the mismatch carrier.

## Trigger Examples

Use this skill for: adapting a finished chapter into storyboard prompts (the CreativeStudio MCP tool `novel_chapter_script_h3`); creating a standalone short script from one core idea, e.g. a Douyin-style short video (the MCP tool `novel_short_script_h3`, which takes `idea` + optional `instruction` + `durationMode` — `fixed` with `targetDurationSeconds` 10-180s, or `auto` for unbounded duration where the model decides total length and segment count from the idea — and returns a `creativeStrategy` commitment `{hookType: awe|humor|conflict, subversion, signatureMoment}` for review); brainstorming hook-typed candidates for an open direction (the MCP tool `novel_short_script_h3_brainstorm`, which diverges across engines and avoids motifs already used by recent scripts); reviewing whether a generated storyboard is cinematic enough; planning beat-to-segment coverage; designing episode-level hooks, emotion cadence, and cliffhanger cut points; choosing camera and lighting language for a scene; staging a signature moment.

Not for: the six-section output grammar itself (use h3-prompt-writing), prose-level novel writing (use novel-writing), or video model API parameters.
