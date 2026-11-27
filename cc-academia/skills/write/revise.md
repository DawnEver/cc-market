# Revise existing text

Sentence by sentence, never a block replacement. Whole paragraphs are written in one go only for a first draft; during revision a block
replacement of a paragraph, section or abstract is BLOCK. Show the analysis first when the text is author-approved
or analysis was asked for.

1. `academia-write resolve --task write --scope <part>` for the part under revision; `explain <id>` on demand. Read the project's `decisions.md`: approved text is BLOCK for meaning changes
   (hard constraint 2).
2. For each sentence of the passage: is it needed (what breaks if it goes)? Keep, cut, merge or replace. Log old
   sentence, new sentence, rule id. Work at the highest broken level first (revision order, higher wins: L1 argument —
   links, funnel opening, causal close — > L2 position — detail follows position, no previews — > L3 sentence > L4
   wording). Rewrite a paragraph from a skeleton of its reasoning. Check in two passes: links first, sentence
   patterns second.
3. In the abstract, introduction, conclusion and outline, a change of logic (order, condensation, restructuring) is a
   proposal to the author with its reason; apply only after approval (hard constraint 1).
4. A term change touching a figure label or legend: list the figure items and wait for approval
   (hard constraint 3); the caption changes with the text.
5. After any split, merge or deletion re-read the whole paragraph and restore lost links.
6. Run `review own`.
