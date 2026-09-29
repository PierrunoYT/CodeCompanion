import { existsSync, realpathSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import type { ProjectInfo } from '@shared/project';
import { readJson, writeJson } from './storage/json_file';

const MAX_RECENT = 20;

// Recent projects and their custom instructions, stored in userData/projects.json.
export class ProjectStore {
  private projects: ProjectInfo[];
  private currentPath: string | null = null;

  constructor(private readonly file: string) {
    this.projects = readJson<ProjectInfo[]>(file, []).filter((project) => typeof project?.path === 'string');
  }

  list(): ProjectInfo[] {
    return [...this.projects].sort((a, b) => b.lastOpened.localeCompare(a.lastOpened));
  }

  current(): ProjectInfo | null {
    return this.projects.find((project) => project.path === this.currentPath) ?? null;
  }

  open(path: string): ProjectInfo {
    const absolute = resolve(path);
    if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
      throw new Error(`Folder not found: ${path}`);
    }
    const real = realpathSync(absolute);
    let project = this.projects.find((candidate) => candidate.path === real);
    if (!project) {
      project = { path: real, name: basename(real) || real, instructions: '', lastOpened: '' };
    } else {
      this.projects = this.projects.filter((candidate) => candidate !== project);
    }
    project.lastOpened = new Date().toISOString();
    this.projects.unshift(project);
    this.currentPath = real;
    this.projects = this.list().slice(0, MAX_RECENT);
    this.persist();
    return { ...project };
  }

  setInstructions(path: string, instructions: string): ProjectInfo {
    const project = this.projects.find((candidate) => candidate.path === path);
    if (!project) throw new Error(`Unknown project: ${path}`);
    project.instructions = instructions;
    this.persist();
    return { ...project };
  }

  remove(path: string): void {
    this.projects = this.projects.filter((project) => project.path !== path);
    if (this.currentPath === path) this.currentPath = null;
    this.persist();
  }

  private persist(): void {
    writeJson(this.file, this.projects);
  }
}
