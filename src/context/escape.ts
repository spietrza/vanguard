/**
 * Escapes angle brackets so untrusted text cannot break out of an XML-tagged prompt block. Escapes every
 * `<` and `>`, so code reads as `Array&lt;string&gt;`; the review prompts use neutralizePromptTags
 * (below), which escapes every `<` but keeps `>`.
 */
export function escapePromptTags(text: string): string {
  return text.replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/**
 * Escape every `<` inside untrusted text. Any narrower rule (a list of tag names, a tag-shape pattern) left
 * a gap: harness framings such as `<system-reminder>`, zero-width characters after `<`, `<?xml`,
 * `<![CDATA[`. With no `<` left, an author cannot close a data block or open an instruction, policy or
 * harness block, and a quoted `<promise>COMPLETE</promise>` cannot mark a partial review complete. Code
 * reads as `Array&lt;string>` and `a &lt; b`; `>` stays, which keeps it readable.
 */
export function neutralizePromptTags(text: string): string {
  return text.replaceAll('<', '&lt;');
}

/** The note every diff carries into a prompt, so a reviewer does not report the escaping as a defect. */
export const DIFF_ESCAPING_NOTE =
  'Every `<` in the diff below is escaped as &lt;; the files on disk hold the real text, so do not report the escaping as a defect.';

/**
 * A diff as the {{PREVIOUS_DIFF}} prompt variable: every `<` neutralized (the diff is agent-written
 * content), prefixed with DIFF_ESCAPING_NOTE. An empty diff stays empty.
 */
export function diffForPrompt(diff: string): string {
  return diff === '' ? '' : `${DIFF_ESCAPING_NOTE}\n\n${neutralizePromptTags(diff)}`;
}
