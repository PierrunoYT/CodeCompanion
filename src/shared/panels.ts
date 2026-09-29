export type PanelName = 'terminal' | 'browser' | 'git';

export type GitFileStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflicted';

export interface GitFile {
  path: string;
  status: GitFileStatus;
}

export interface GitStatus {
  isRepo: boolean;
  branch: string | null;
  files: GitFile[];
}
