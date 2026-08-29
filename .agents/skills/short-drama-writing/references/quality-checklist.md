# Storyboard Quality Checklist

Run this after drafting a storyboard and before delivery. Each item is a question with a concrete pass condition. The pipeline's automated hints cover the mechanical subset (camera-language coverage); this checklist is the full directing and dramaturgy pass (episode-layer rules expand `dramaturgy.md`).

## 1. Coverage

- [ ] Every story beat (memory, setup, hook, decision, action, exchange) is carried by at least one segment.
- [ ] Every information block is *presented* — flashback frames, spoken lines, or on-screen text — not just reacted to.
- [ ] No segment exists without a beat; no invented plot exists beyond the prose.

## 2. Shot density and rhythm

- [ ] Every `[Shot N]` states framing (shot size, and angle when meaningful).
- [ ] Every shot names its camera behavior (motion type per the H3 grammar, or a deliberate static hold).
- [ ] Every shot has a light/atmosphere element (source, direction, or airborne particle).
- [ ] Each segment has one rhythm peak and one brake; the pattern differs across segments (not five identical builds).
- [ ] Shot 1 of the chapter (or segment) opens with an establishing beat; the last shot of each segment exits toward the next.
- [ ] Signature moments (where the prose peaks) use the build → peak → shock → afterglow pattern; no fabricated spectacle elsewhere.

## 2b. Dramaturgy (episode layer)

- [ ] The first segment opens inside the conflict; no routine or scenery-first build.
- [ ] An emotion node (clash, reveal, or decision) lands every 2-4 segments; no three consecutive flat segments.
- [ ] The first small reversal lands within the first third of the episode, and traces to a beat presented earlier (plant → overlook → detonate).
- [ ] Every segment's exit raises a question or the stakes; the final segment cuts on the impact instant, not the afterglow.
- [ ] Every spoken line confirms identity, ignites conflict, or states consequence; filler lines are compressed out.
- [ ] Key emotional beats are readable with sound off (faces, actions, on-screen text).
- [ ] On-screen speaking cast stays within the core triangle plus a small handful; character labels are visually anchored.

## 3. Language fidelity

- [ ] Dialogue preserves original language in `<d>` tags with speaker IDs `(S1)`, `(S2)`…
- [ ] Compressed lines keep the prose's facts and causality; no invented lines or merged speakers.
- [ ] Inner monologue appears as flashback or spoken/voiceover content, never as an empty "thinking" shot.
- [ ] On-screen text (signs, labels) is quoted verbatim in its original language.

## 4. Reference and continuity

- [ ] Shared preset subjects are referenced by label, never redefined inside a segment.
- [ ] New subjects are numbered continuously after the shared maximum and are used in the body.
- [ ] Character appearance matches the shared baseline in every segment (clothing, hair, props).
- [ ] Cut times are strictly increasing, inside the segment duration, and `[Shot 1]` carries no timestamp.
- [ ] The last cut leaves time for the action to land; nothing is scheduled past `durationSeconds`.

## 5. Sound and music

- [ ] `overall_soundscape` covers ambience and physical sounds only (no dialogue repetition).
- [ ] `non_diegetic_music` describes instrumentation/tempo/dynamics and aligns swells or cuts with picture moments.
- [ ] Per-shot synchronized sounds live in the detailed description.

## 6. Format

- [ ] Six sections in canonical order when definitions exist; five when the segment reuses shared subjects only.
- [ ] Summary carries the bracketed task-type prefix (`[reference generation]`…).
- [ ] Genre visuals are concrete and shootable (color, motion, location), consistent with the established visual system.

Mechanical subset automated by the pipeline: per-shot camera-language coverage is surfaced as hints in the generation result; structural violations (labels, timing, dialogue tags) are hard-rejected with repair feedback.
