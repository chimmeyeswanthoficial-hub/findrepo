#!/usr/bin/env node
// UserPromptSubmit hook: whatever this prints is added to the agent's context for this prompt.
// Kept to one short line so it costs almost nothing, and skipped for tiny prompts and slash commands.
let input = '';
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', () => {
  let prompt = '';
  try { prompt = JSON.parse(input).prompt ?? ''; } catch { /* no input: stay silent */ }
  if (prompt.trim().length < 25 || prompt.trim().startsWith('/')) return;
  console.log(
    'findrepo: if this task involves building or choosing a library, tool, component or workflow, ' +
    'use the findrepo skill first to check for an existing maintained repo or agent skill. ' +
    'Skip for small edits, questions and debugging. Ask before installing anything.'
  );
});
