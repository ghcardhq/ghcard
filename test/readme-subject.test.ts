import { chmod, mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyBlock, markerId, upsertBlock } from '../src/readme.js';
import { hasAllWidgets, parseSubject } from '../src/subject.js';

describe('applyBlock', () => {
  it('inserts after the first heading', () => {
    const { content, edit } = applyBlock('# Hi\n\nText.\n', 'octocat', 'SNIP');
    expect(edit).toBe('inserted');
    expect(content).toBe('# Hi\n\n<!-- ghcard:octocat -->\nSNIP\n<!-- /ghcard:octocat -->\n\nText.\n');
  });

  it('inserts at the top without a heading, and into an empty file', () => {
    expect(applyBlock('Text.\n', 'x', 'S').content).toBe('<!-- ghcard:x -->\nS\n<!-- /ghcard:x -->\n\nText.\n');
    expect(applyBlock('', 'x', 'S').content).toBe('<!-- ghcard:x -->\nS\n<!-- /ghcard:x -->\n');
  });

  it('replaces only its own block, then reports unchanged', () => {
    const start = applyBlock(applyBlock('# Hi\n', 'other', 'O').content, 'octocat', 'OLD').content;
    const updated = applyBlock(start, 'octocat', 'NEW');
    expect(updated.edit).toBe('updated');
    expect(updated.content).toContain('<!-- ghcard:other -->\nO\n');
    expect(updated.content).toContain('NEW');
    expect(updated.content).not.toContain('OLD');
    expect(applyBlock(updated.content, 'octocat', 'NEW').edit).toBe('unchanged');
  });

  it('derives safe marker ids', () => {
    expect(markerId('OctoCat/Hello World-->')).toBe('octocat/hello-world---');
  });

  it('creates, then updates a file and keeps its mode', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ghcard-readme-'));
    const path = join(dir, 'README.md');
    expect(await upsertBlock(path, 'x', 'A')).toBe('created');
    await chmod(path, 0o600);
    expect(await upsertBlock(path, 'x', 'B')).toBe('updated');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await upsertBlock(path, 'x', 'B')).toBe('unchanged');
  });
});

describe('parseSubject', () => {
  it.each([
    ['octocat', 'octocat', ''],
    ['octocat/hello-world', 'octocat', 'hello-world'],
    ['https://github.com/octocat', 'octocat', ''],
    ['http://www.github.com/octocat/hello-world/', 'octocat', 'hello-world'],
    ['GitHub.com/octocat/hello-world.git', 'octocat', 'hello-world'],
    ['  octocat  ', 'octocat', ''],
    ['octocat/', 'octocat', ''],
  ])('%s', (input, username, repo) => {
    expect(parseSubject(input)).toEqual({ username, repo });
  });

  it.each(['', 'a/b/c', '/repo', 'https://github.com/', 'octocat/.git'])('rejects %j', input => {
    expect(() => parseSubject(input)).toThrow(/is not a GitHub user or owner\/repo/);
  });

  it('matches widgets case-insensitively', () => {
    expect(hasAllWidgets(['Streak', 'stats'], ['streak'])).toBe(true);
    expect(hasAllWidgets(['stats'], ['streak'])).toBe(false);
    expect(hasAllWidgets(['stats'], [])).toBe(true);
  });
});
