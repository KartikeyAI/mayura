# Mayura UI design language

Mayura should feel like a quiet workspace for reading, writing and reviewing actions. The conversation leads. The
composer is the clearest interactive surface, and a pending approval is the strongest change in tone.

## Surfaces and hierarchy

- Use a warm canvas and a slightly darker navigation surface. The change in tone defines the rail. Keep the
  welcome content and composer in a responsive column capped at 540 px. The transcript and floating composer
  share a 640 px cap. A soft, centered
  gradient marks the welcome screen and settles after its entrance.
- Keep the composer’s outline because it identifies the input. Use fill and type weight for active navigation.
  Suggested prompts use text-only pills. Citations and other secondary actions stay flat, with visible hover and
  keyboard states.
- Let answers read directly on the canvas. Give the user’s message a soft fill. Keep citation and artifact
  controls next to the answer. Inspect the exact source beside the chat on desktop and in a full-screen sheet
  on smaller screens. Use a single quote rule to distinguish the source text.
- Keep thread history in the navigation rail. Use a quiet selected fill and call out only approvals that are still pending.
- Use pine in fills, text and icons for primary actions and citations. Keep borders and focus outlines neutral in
  every state, including drag and active states. Reserve amber surfaces for decisions or errors that need
  attention. An approval has one enclosing surface, a plain disclosure and a single primary action. While it is
  pending, hide the unavailable composer so the decision has the focus.
- Use Geist for UI and reading. Use monospace for exact tool input. Build hierarchy with weight, line length and
  spacing. Save shadows for controls that actually float over another surface.

## Interaction

- The same composer moves between the welcome and conversation layouts. In a conversation it floats over the
  transcript. Leave scroll clearance for its current height. Keep typing, focus and the send control available
  immediately. Animate the first appearance of meaningful content and the reveal of details.
- Keep toolbar controls compact and named. Surface file context inside the draft. Use a neutral fill for the drop
  target, and let voice controls replace the toolbar during recording so the timer and review actions have space.
- Put reply actions beneath settled text. Add an editable quote to the draft as context and leave existing typing intact.
- Tie progress and approval feedback to the actual AG-UI events. Keep source disclosure and return-to-latest
  controls close to the content they affect. Preserve keyboard focus, text feedback and reduced-motion behavior.
- Keep the latest run's activity in a compact disclosure near its prompt. Show the exact proposed document lines
  and destination in the approval surface above the decision controls.
- Keep rich reply controls within the same reading measure. Use typed chart, media and link components in the
  inspector. Render agent text as text and give videos and audio a caption or transcript where applicable.

Theme values live in the standalone package. Use these decisions when adding component variants or embedding
the conversation in a host app.
