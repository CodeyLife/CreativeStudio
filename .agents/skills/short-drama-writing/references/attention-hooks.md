# Attention Hooks — the engine layer for idea-mode shorts

A tens-of-seconds short has no serialized patience to earn: the viewer decides within
seconds whether to stay. Before any shot is written, idea mode **commits one attention
engine** and designs the whole piece around it. The commit is not decoration — the
runtime pipeline records it as the top-level `creativeStrategy` object
(`{hookType, subversion, signatureMoment}`) of every generated short, and every beat
must visibly serve it. This file is the mechanism manual behind that commitment; the
runtime contract lives in the `short.script` execution point of the h3-video-prompt
skill, and the code-side schema mirrors (`SHORT_SCRIPT_HOOK_ENGINES`) are the same
three engines defined here.

## The three engines

| Engine | Promise to the viewer | Beat pattern | Exit |
| --- | --- | --- | --- |
| `awe` | "you will see something you cannot unsee" | orientation → progression → escalation → the frame | the signature frame or its aftershock |
| `humor` | "what you assume will be contradicted, played straight" | setup → (setup) → payoff, escalating | the punchline frame + a deadpan reaction beat |
| `conflict` | "someone wants something against resistance" (only when the idea itself states a conflict) | situation → pressure → reversal/detonation | cut at the impact instant |

A piece may flavor one engine with moments of another (an awe short with a wry beat),
but it commits to **one** — mixed engines with equal weight read as no engine.

## Expectation → subversion (all engines)

The viewer arrives carrying a template: the genre's stock imagery, the idea's most
predictable development, the first-three-seconds reading of scale and rules. Design
the piece against that template, not with it:

1. **Name the expectation in one sentence** — what would a generic version of this
   idea show by second three? Write it down.
2. **Pick the one reversal** — the beat that overturns, escalates beyond, or
   recontextualizes that expectation. Exactly one; several competing reversals
   cancel each other.
3. **Make it land visually** — the subversion is a state change inside a frame
   (position, scale, material, rule, identity of the subject), not a line of
   dialogue announcing it. If removing the spoken line removes the surprise, the
   surprise was never in the picture.
4. **Protect the reversal** — no shot may pre-enact or foreshadow its mechanics
   away; buildup aims at it while keeping the mechanism off-frame until it lands.

For awe, the subversion is usually *escalation beyond the predicted scale or rule*
(the thing turns out to be far larger, inverted, or governed by a different law than
first read). For humor it is the *payoff of the mismatch*. For conflict it is the
dramaturgy layer's reversal-with-plant device.

## The signature frame (记忆镜头)

One moment per piece — 3-5 seconds, retellable in one sentence ("the shot where…"),
the frame a viewer would screenshot or describe to a friend. Rules:

- **Unique**: two equally strong candidate frames means none is chosen — merge,
  demote, or move one to a future piece.
- **Served by every beat**: each beat either builds tension toward it or detonates /
  settles from it; a beat serving neither is filler regardless of how pretty it is.
- **The exit is it or its aftershock**: the final segment cuts at the frame's peak
  or the first reaction inside it — never several seconds after it has settled.
- It is *designed before shots are written* (it is the `signatureMoment` field), and
  the camera art of its shot carries the full stack: composition, one decisive
  lighting move, one camera move, one state change.

## Awe: the sublime, by carrier not by cliché

The mistake is equating awe with one prop class (giant buildings). Awe is a felt
relation between the viewer's scale-reference and something that exceeds
comprehension; the *carrier* only needs to be a single, silhouette-readable visual
or spatial subject. Valid carrier families, none privileged:

- **Megastructure** — built forms at impossible scale (already the model's default;
  only choose it if the treatment itself is unconventional).
- **Celestial / atmospheric** — bodies, tides of light, weather systems treated as
  architecture: a ring crossing the sky, a cloud sea behaving like liquid, a sun
  that moves wrong.
- **Living colossal** — an animal, plant, or being whose body is the landscape;
  scale revealed by inhabitants, parasol-sized details, or shadow sweeps.
- **Natural phenomenon frozen** — a wave mid-break turned to a material, a lightning
  lattice kept standing, a canyon shaped by something that no longer explains itself.
- **Spatial-law anomaly** — the frame's geometry obeys one altered rule (inside is
  larger than outside; one direction no longer returns; distance behaves like depth
  of field). The anomaly is the spectacle; the camera's job is to make the rule
  legible, then reveal its consequence.

Craft rules that hold across carriers:

1. **One dominant form + vast negative space.** Density-stacking (a screen packed
   with identical units) reads as clutter, not monumentality; repetition must
   breathe, extending toward the vanishing point.
2. **A human (or human-scale) reference stays in frame** so the excess has a unit —
   the same figure, a door, a lantern, a body silhouette. Under `humor` the
   reference may instead behave with oblivious indifference, which itself conveys
   the scale.
3. **Progression of reveals**, not one establishing shot: orientation (what am I
   looking at?) → partial reveal (how big is it?) → the law or the anomaly (what
   is happening to it?) — each beat changing what the first frame was assumed to
   be.
4. **The strike emerges from the anchor's own logic** — an interior anomaly, a
   material behaving wrong, the scale dislocation itself — never a generic impact
   nail (cracks, sky-tears, light-beams) attachable to any scene.

## Humor: incongruity played straight

Comedy for a tens-of-seconds visual medium is *engineered mismatch*, delivered with
deadpan discipline. Mechanisms, in priority order:

1. **The three mismatch types** — pick one per piece:
   - **Scale mismatch**: something vast doing something trivial, or something tiny
     treated with ceremony (a colossal being carefully threading a needle; an army
     saluting a single teacup).
   - **Rule mismatch**: the world obeys one altered rule and every character treats
     it as mundane (gravity applies only to the anxious; shadows clock out early).
   - **Status/role mismatch**: the dignity of a form contradicts the content of the
     act (a ritual-grade ceremony performed for an absurdly small errand; a fearsome
     silhouette doing paperwork).
2. **Play it straight (一本正经).** Nobody in the piece knows this is funny. The
   more solemn the performance, camera language, and score, the harder the laugh.
   Winking at the viewer (comic mugging, zany SFX, characters reacting as if surprised
   by the joke) deflates the mismatch.
3. **Setup → payoff timing (三步一断).** Setup establishes the assumed frame;
   optionally a second setup confirms it; the payoff breaks it. Budget the beats so
   the assumed frame is fully believed *before* it breaks — a punchline that lands
   before the expectation exists lands nowhere. In a 2-4 segment short: segment(s)
   of plain establishment, then the break, then exactly one reaction beat — never a
   second joke after the punchline.
4. **The punchline must be in a frame.** The line carrying the payoff lands *on the
   shot that shows the mismatch*, immediately followed by a held deadpan reaction
   frame (the environment, the crowd, the other party — expressionless). If the joke
   survives muting the video, it lives only in dialogue; redesign it into the picture.
5. **Music/picture incongruity** is a first-class device: a grand, reverent, or
   tender score over the trivial/absurd image (or the reverse) doubles the mismatch.
   This is one of the few cases where the non-diegetic score deliberately argues
   with the picture.
6. **Humor never borrows conflict.** The comedy engine must not import adversarial
   events, threats, or stakes the idea does not state — the mismatch, not menace,
   is the source of the laugh; the spectacle-mode no-injection rule applies to it
   unchanged.

## Cross-work anti-recurrence

Repetition across a channel's catalogue kills retention faster than repetition
inside a piece. The pipeline automates its half — recent shorts' core ideas are
injected into brainstorm and generation prompts as an avoidance list
(`avoidMotifs`, cross-work 反同质 line, derived from the browser-side IndexedDB
history since 09-17 — the server-side `short_scripts` table it used to read was
dropped by migration 093, never
a fixed-phrase blacklist). The orchestrating agent's half:

- Before committing an idea, skim the recent output list; if the new concept is a
  re-skin of any earlier anchor (same carrier, same anomaly, same mismatch shape),
  re-derive from expectation → subversion, keeping the theme, changing the logic.
- Vary the *engine* across consecutive pieces as well as the imagery: three awe
  shorts in a row flatten the channel's rhythm even with different anchors.
- Homogeneity test to run on a candidate: name the earlier piece's one-sentence
  picture ("the shot where…"); if the candidate's signature frame is a synonym,
  it's a re-skin, not a new piece.

## Self-check (idea mode, before delivery)

1. Is the committed engine visible in the beat pattern, not just the label?
2. Would a viewer of the first two seconds predict the final frame? If yes → the
   subversion never landed.
3. Can the signature frame be retold in one sentence? Is it the exit?
4. Humor: is every character serious? Does the payoff exist as an image? Is there
   exactly one reaction beat after it? Any menace smuggled in?
5. Awe: is the carrier anything other than this archetype's most famous symbol?
   Does a scale reference keep the excess measurable?
6. Strip all dialogue: does the piece still subvert, still peak?
