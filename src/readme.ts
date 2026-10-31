/**
 * Insert or update a card snippet in a Markdown file.
 *
 * The snippet sits between marker comments so a later run replaces it in
 * place instead of appending a second copy:
 *
 *   <!-- ghcard:octocat -->
 *   [![GitHubCard for octocat](…)](https://github.com/octocat)
 *   <!-- /ghcard:octocat -->
 */
import { readFile, stat, writeFile } from 'node:fs/promises';

export type Edit = 'created' | 'inserted' | 'updated' | 'unchanged';

/** A stable marker id derived from a card subject. */
export function markerId(subject: string): string {
  return subject.toLowerCase().replace(/[^a-z0-9._/-]/g, '-');
}

function markers(id: string): [string, string] {
  return [`<!-- ghcard:${id} -->`, `<!-- /ghcard:${id} -->`];
}

/** Return `content` with the block for `id` set to `snippet`. */
export function applyBlock(content: string, id: string, snippet: string): { content: string; edit: Edit } {
  const [start, end] = markers(id);
  const block = `${start}\n${snippet.trim()}\n${end}`;

  const i = content.indexOf(start);
  if (i >= 0) {
    const j = content.indexOf(end, i);
    if (j >= 0) {
      const next = content.slice(0, i) + block + content.slice(j + end.length);
      return next === content ? { content, edit: 'unchanged' } : { content: next, edit: 'updated' };
    }
  }

  // Not present yet: put it directly after the first heading if there is one,
  // otherwise at the top, which is where a profile card belongs.
  const lines = content.split(/(?<=\n)/);
  for (let k = 0; k < lines.length; k++) {
    if (lines[k]!.startsWith('# ')) {
      let head = lines.slice(0, k + 1).join('');
      if (!head.endsWith('\n')) head += '\n';
      return { content: `${head}\n${block}\n${lines.slice(k + 1).join('')}`, edit: 'inserted' };
    }
  }
  if (content === '') return { content: `${block}\n`, edit: 'inserted' };
  return { content: `${block}\n\n${content}`, edit: 'inserted' };
}

/** Edit the file at `path`, creating it if needed. */
export async function upsertBlock(path: string, id: string, snippet: string): Promise<Edit> {
  let raw = '';
  let existed = true;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(`read ${path}: ${(error as Error).message}`);
    }
    existed = false;
  }
  const { content, edit } = applyBlock(raw, id, snippet);
  if (edit === 'unchanged') return 'unchanged';
  let mode = 0o644;
  if (existed) mode = (await stat(path)).mode & 0o777;
  try {
    await writeFile(path, content, { mode });
  } catch (error) {
    throw new Error(`write ${path}: ${(error as Error).message}`);
  }
  return existed ? edit : 'created';
}
