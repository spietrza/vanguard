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
