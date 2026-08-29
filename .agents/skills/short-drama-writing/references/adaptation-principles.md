# Adaptation Principles: Chapter Prose → Storyboard Segments

How a committed chapter becomes a shootable storyboard without losing plot or gaining invention. The structural contract (beat IDs, segment schema, shared-subject mechanics) is enforced by the generation pipeline; this file explains the directing judgment behind it. Episode-level dramaturgy (opening hooks, emotion cadence, cliffhanger cut points) is covered in `dramaturgy.md`.

## 1. Beat enumeration comes before segmentation

Read the chapter and enumerate every beat that carries story information: actions and their outcomes, dialogue exchanges, memories and identity material, world rules and setups, deadlines and hooks, belief shifts and decisions. Each beat entry must state its concrete information points (who, where, what changes) — an entry like "memory flood" without its contents is a summary, not a beat.

Every beat is then mapped to exactly one segment (or shared by adjacent ones). A beat mapped to no segment is dropped plot; a segment mapped to no beat is filler.

## 2. Information must be presented, not reacted to

Background material (identity, obligations, world rules, deadlines) cannot ride on reaction shots. Three presentation channels:

1. **Flashback frames** (`[Flashback]` markers): depict the past concretely — who, where, doing what, under what light. Two to four frames per memory.
2. **Spoken lines** (`<d>` tags, including off-screen voiceover): state the information directly, preserving the prose's fact semantics; the speaker's lips stay closed for voiceover per the H3 grammar.
3. **On-screen text**: visible letters, banners, or labels for information the scene can plausibly show.

A clutching-head or trembling shot may accompany the information but never replaces it.

## 3. Segment budget and rhythm

- One segment = 5-10 seconds = one complete action, reaction, or dialogue exchange.
- Working budget: ~350 CJK characters of prose per segment; derive the floor, never pad.
- Rhythm per segment: an establishing beat (space + subject), a build (the action escalates or the exchange turns), a peak (impact, reveal, line lands), and a brake (held close-up, readable line, settle) before the exit.
- Adjacent segments chain: each exit state is the next entry state; a hook (deadline, unresolved question) may be spoken in the last segment to pull forward.
- Exit states are hooks, not closures: the strongest exits cut on the impact instant (see `dramaturgy.md` §3); one emotion node — clash, reveal, or decision — lands every 2-4 segments.

## 4. Signature moments

When the prose offers a natural high point, stage it with the signature pattern: build → peak → shock reaction → afterglow (see cinematography.md §5). One or two signature moments per chapter are enough; every segment having a peak means no segment has one. Static chapters may deliberately brake instead — a held detail shot is a legitimate choice, not a failure.

## 5. Shared subjects

If a preset library exists (defined by the author before generation), its subjects are referenced by the same labels and never redefined inside a segment; only new subjects get definition lines, numbered continuing after the shared maximum. If a segment introduces no new subject, its subject-definitions section is empty and the segment ships five sections. The shared library travels with the output as a standalone block for the video workflow.

## 6. Dialogue discipline

- Preserve the original language inside `<d>` tags and the fact/causal semantics of the prose.
- Compression is allowed (prose sentences become speakable lines); rewriting facts, merging unrelated speakers, or inventing lines is not.
- Inner monologue becomes either a flashback (visible past) or a spoken/voiceover line (stated information) — never a framed "thinking" shot with no content.
- Dense-dialogue segments prioritize the complete spoken timeline over descriptive word counts.

## 7. Failure classes

| Symptom | Root cause | Fix |
| --- | --- | --- |
| Segments read as plot summary | Shots written without the Shot Equation | Rewrite each `[Shot N]` with framing, camera, light, state change |
| Background dropped | Beat mapped but never presented | Give it flashback/dialogue/on-screen-text presence in its carrying segment |
| All segments same intensity | No peak/brake design | Assign rhythm intents; move the peak to the prose's strongest change |
| Viewers lost after a hook | The deadline/setup it references was dropped earlier | Restore the setup beat that gives the hook meaning |
| Definitions repeat across segments | Shared library ignored | Reference shared labels; write only new subjects |
| Cut past the segment duration | Cut points not budgeted | Recompute; the last cut must leave room for the action to land |
