const context = require('../context');
const fs = require('graceful-fs');
const path = require('path');
const ignore = require('ignore');
const { withErrorHandling } = require('../utils');
const ignorePatterns = require('../static/embeddings_ignore_patterns');

// Describes the current working directory for the prompt.
class ProjectState {
  constructor() {
    // Set by getFolderStructure: true when the directory is too large to list in full, so the
    // prompt should be supplemented with embedding-based file suggestions.
    this.searchRelevantFiles = false;
  }

  async toText() {
    const dirName = path.basename(await context.chatController.terminalSession.getCurrentDirectory());

    let projectStateText = '';
    projectStateText += `Current directory is '${dirName}'. The full path to this directory is '${context.chatController.agent.currentWorkingDir}'`;
    if (context.chatController.agent.projectController.currentProject) {
      const filesInFolder = await withErrorHandling(this.getFolderStructure.bind(this));
      if (filesInFolder) {
        projectStateText += `\nThe contents of this directory (excluding files from .gitignore): \n${filesInFolder}`;
      }
    }

    return projectStateText ? `\n<current_project_state>\n${projectStateText}\n</current_project_state>\n` : '';
  }

  async getFolderStructure() {
    const ig = ignore().add(ignorePatterns);
    const rootDir = context.chatController.agent.currentWorkingDir;

    // Recursive function to list files
    const listFiles = async (dir, allFiles = [], currentPath = '') => {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      for (let entry of entries) {
        const entryPath = path.join(dir, entry.name);
        const relativePath = path.join(currentPath, entry.name);

        if (entry.isDirectory()) {
          await listFiles(entryPath, allFiles, relativePath);
        } else {
          allFiles.push(relativePath);
        }
      }
      return allFiles;
    };

    try {
      const allFiles = await listFiles(rootDir);
      const filesExcludingIgnored = allFiles.filter((file) => !ig.ignores(file));

      if (allFiles.length === 0) {
        // If directory is empty
        this.searchRelevantFiles = false;
        return 'The directory is empty.';
      } else if (filesExcludingIgnored.length <= 30) {
        this.searchRelevantFiles = false;
        return filesExcludingIgnored.map((file) => `- ${file}`).join('\n');
      } else {
        // If more than 30 files, only show top-level directories and files
        this.searchRelevantFiles = true;
        const topLevelEntries = await fs.promises.readdir(rootDir, { withFileTypes: true });
        const filteredTopLevelEntries = topLevelEntries.filter((entry) => !ig.ignores(entry.name));

        const folderStructure = [];
        for (const entry of filteredTopLevelEntries) {
          if (entry.isDirectory()) {
            folderStructure.push(`- ${entry.name}/`);
            const subEntries = await fs.promises.readdir(path.join(rootDir, entry.name), { withFileTypes: true });
            const filteredSubEntries = subEntries.filter(
              (subEntry) => !ig.ignores(path.join(entry.name, subEntry.name)),
            );
            for (const subEntry of filteredSubEntries) {
              folderStructure.push(`  - ${subEntry.name}${subEntry.isDirectory() ? '/' : ''}`);
            }
          } else {
            folderStructure.push(`- ${entry.name}`);
          }
        }

        return folderStructure.join('\n');
      }
    } catch (error) {
      context.chatController.chat.addFrontendMessage(
        'error',
        `Error occurred while checking directory structure in ${rootDir}.
       <br>Please change directory where app can read/write files or update permissions for current directory.`,
      );
      return;
    }
  }
}

module.exports = ProjectState;
