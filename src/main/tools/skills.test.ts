import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Workspace } from './workspace';
import { listSkills, loadSkillTool, readSkill } from './skills';

describe('project skills', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'patch-skills-'));
    dirs.push(dir);
    return dir;
  }

  function write(root: string, files: Record<string, string>): void {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(root, path, '..'), { recursive: true });
      writeFileSync(join(root, path), content);
    }
  }

  function projectWith(files: Record<string, string>): Workspace {
    const root = tempDir();
    write(root, files);
    return new Workspace(root);
  }

  it('lists markdown skills with their first non-heading line as description', () => {
    const workspace = projectWith({
      '.patch/skills/deploy.md': '# Deploy\n\nRun the release checklist: bump versions, tag, publish.\n',
      '.patch/skills/review.md': 'Review PRs against CONTRIBUTING.md first.\n\nMore detail below.\n',
    });
    expect(listSkills(workspace)).toEqual({
      skills: [
        { name: 'deploy', description: 'Run the release checklist: bump versions, tag, publish.' },
        { name: 'review', description: 'Review PRs against CONTRIBUTING.md first.' },
      ],
      omitted: 0,
    });
  });

  it('returns no skills for a project without the folder', () => {
    expect(listSkills(projectWith({ 'README.md': 'hi\n' }))).toEqual({ skills: [], omitted: 0 });
  });

  it('lists the first 20 skills and counts the rest', () => {
    const files = Object.fromEntries(
      Array.from({ length: 23 }, (_, i) => [`.patch/skills/s${String(i).padStart(2, '0')}.md`, `Skill ${i}.\n`]),
    );
    const { skills, omitted } = listSkills(projectWith(files));
    expect(skills).toHaveLength(20);
    expect(skills[0]?.name).toBe('s00');
    expect(omitted).toBe(3);
  });

  it('ignores a skills folder that is a link to somewhere outside the project', () => {
    const outside = tempDir();
    write(outside, { 'secret.md': 'TOKEN=outside-the-project\n' });
    const root = tempDir();
    mkdirSync(join(root, '.patch'));
    // A junction needs no special rights on Windows; elsewhere the type is ignored and a normal link is made.
    symlinkSync(outside, join(root, '.patch', 'skills'), 'junction');
    const workspace = new Workspace(root);
    expect(listSkills(workspace)).toEqual({ skills: [], omitted: 0 });
    expect(() => readSkill(workspace, 'secret')).toThrow(/outside the project/);
  });

  it('reads a skill through the confined workspace', () => {
    const workspace = projectWith({ '.patch/skills/deploy.md': 'Step one.\n' });
    expect(readSkill(workspace, 'deploy')).toContain('Step one.');
  });

  it('rejects traversal names and unknown skills with the available list', () => {
    const workspace = projectWith({ '.patch/skills/deploy.md': 'Step one.\n' });
    expect(() => readSkill(workspace, '../secrets')).toThrow(/Invalid skill name/);
    expect(() => readSkill(workspace, '..\\secrets')).toThrow(/Invalid skill name/);
    expect(() => readSkill(workspace, 'missing')).toThrow(/No skill named "missing". Available skills: deploy/);
  });

  it('loads a skill through the tool', async () => {
    const workspace = projectWith({ '.patch/skills/deploy.md': 'Bump, tag, publish.\n' });
    const output = await loadSkillTool.run({ name: 'deploy' }, { workspace } as never);
    expect(output.content).toContain('Bump, tag, publish.');
    expect(output.summary).toBe('Loaded skill deploy');
  });
});
