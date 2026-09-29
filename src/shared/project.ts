export interface ProjectInfo {
  path: string;
  name: string;
  // Added to the system prompt of every chat in this project.
  instructions: string;
  lastOpened: string;
}
