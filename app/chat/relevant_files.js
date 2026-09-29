const context = require('../context');
const fs = require('graceful-fs');
const { getTokenCount, isTextFile, normalizedFilePath } = require('../utils');

const MAX_RELEVANT_FILES_TOKENS = 10000;
const MAX_RELEVANT_FILES_COUNT = 7;
const MAX_FILE_SIZE = 30000;

// Chooses which files' contents are inlined in the prompt (files the chat touched, recently edited
// files, and embedding-based suggestions) and keeps that set within a token budget.
class RelevantFiles {
  constructor(chat, { projectState, summary, describeTask }) {
    this.chat = chat;
    this.projectState = projectState;
    this.summary = summary;
    this.describeTask = describeTask;
    this.lastMessageIdForRelevantFiles = 0;
    this.reduceRelevantFilesContextMessageId = 0;
    this.lastEditedFilesTimestamp = chat.startTimestamp;
    this.taskRelevantFiles = [];
  }

  async suggestions() {
    if (!this.projectState.searchRelevantFiles) {
      return '';
    }

    let lastBackendMessage = this.chat.backendMessages[this.chat.backendMessages.length - 1];
    let lastUserMessage;
    if (!lastBackendMessage) {
      lastUserMessage = this.chat.task;
    } else {
      if (lastBackendMessage.role === 'user') {
        lastUserMessage = lastBackendMessage;
      }
    }

    if (!lastUserMessage) {
      return '';
    }

    const params = {
      query: this.chat.task + (lastUserMessage ? ' ' + lastUserMessage.content : ''),
      limit: 10,
      filenamesOnly: true,
    };
    const projectController = context.chatController.agent.projectController;
    if (!projectController.currentProject) {
      return '';
    }

    const relevantFilesAndFolders = await projectController.searchEmbeddings(params);
    if (!relevantFilesAndFolders || relevantFilesAndFolders.length === 0) {
      return '';
    } else {
      const relevantFilesAndFoldersMessage = relevantFilesAndFolders
        .map((result) => {
          return `- "${result}"`;
        })
        .join('\n');
      return `These files might or might not be relevant to the task:\n<relevant_files_and_folders>\n${relevantFilesAndFoldersMessage}\n</relevant_files_and_folders>\n`;
    }
  }

  async contents() {
    const relevantFileNames = await this.getListOfRelevantFiles();
    if (relevantFileNames.length === 0) {
      return '';
    }

    let fileContents = await this.getFileContents(relevantFileNames);
    fileContents = await this.reduceRelevantFilesContext(fileContents, relevantFileNames);

    return fileContents
      ? `\n\nCurrent content of the files (do not read these files again. Do not thank me for providing these files):\n<relevant_files_contents>${fileContents}\n</relevant_files_contents>`
      : '';
  }

  async getListOfRelevantFiles() {
    const chatInteractionFiles = await this.getChatInteractionFiles();
    const editedFiles = context.chatController.agent.projectController.getRecentModifiedFiles(
      this.lastEditedFilesTimestamp,
    );
    this.lastEditedFilesTimestamp = Date.now();
    const combinedFiles = [...new Set([...chatInteractionFiles, ...this.taskRelevantFiles, ...editedFiles])].slice(
      0,
      20,
    );
    this.taskRelevantFiles = combinedFiles;

    return combinedFiles;
  }

  async getChatInteractionFiles() {
    const chatFiles = this.chat.backendMessages
      .filter((message) => message.id > this.lastMessageIdForRelevantFiles)
      .filter((message) => message.role === 'assistant' && message.tool_calls)
      .flatMap((message) =>
        message.tool_calls
          .map((toolCall) => {
            const parsedArguments = context.chatController.agent.parseArguments(toolCall.function.arguments);
            return parsedArguments.hasOwnProperty('targetFile') ? parsedArguments.targetFile : undefined;
          })
          .filter((file) => file !== undefined),
      );
    const normalizedFilePaths = await Promise.all(chatFiles.map((file) => normalizedFilePath(file)));
    const chatInteractionFiles = normalizedFilePaths
      .filter((file) => fs.existsSync(file) && !fs.statSync(file).isDirectory())
      .reverse();
    this.lastMessageIdForRelevantFiles = this.chat.backendMessages.length - 1;

    return chatInteractionFiles;
  }

  async getFileContents(fileList) {
    if (fileList.length === 0) {
      return '';
    }

    const fileReadPromises = fileList.map((file) => this.readFile(file));
    const fileContents = await Promise.all(fileReadPromises);

    return fileList
      .map((file, index) => `\n<file_content file="${file}">\n${fileContents[index]}\n</file_content>`)
      .join('\n\n');
  }

  async reduceRelevantFilesContext(fileContents, fileList) {
    const fileContentTokenCount = getTokenCount(fileContents);
    const lastMessageId = this.chat.backendMessages.length - 1;
    if (
      fileContentTokenCount > MAX_RELEVANT_FILES_TOKENS &&
      fileList.length > MAX_RELEVANT_FILES_COUNT &&
      (lastMessageId - this.reduceRelevantFilesContextMessageId >= 10 || this.reduceRelevantFilesContextMessageId === 0)
    ) {
      this.reduceRelevantFilesContextMessageId = lastMessageId;
      const relevantFiles = await this.updateListOfRelevantFiles(fileContents);
      if (Array.isArray(relevantFiles)) {
        console.log('Reducing relevant files context', relevantFiles);
        this.taskRelevantFiles = relevantFiles.slice(0, MAX_RELEVANT_FILES_COUNT);
        return await this.getFileContents(relevantFiles);
      }
    }

    return fileContents;
  }

  async updateListOfRelevantFiles(fileContents) {
    const messageHistory = [this.describeTask(), await this.summary.build()];

    const prompt = `AI coding assistant is helping user with a task.
    Here is a summary of the conversation and what was done: ${messageHistory}
    
    The content of the files is too long to process. Out of the list of files below, select the most relevant files that the assistant still needs to know the contents of in order to complete the user's task.
    The files are:\n\n${fileContents}
    
    Include only required files, exclude files that are already processed or most likely not needed.
    Respond with an array of file paths exactly as they appeared (do not shorten or change file paths) in the list above, separated by commas.
    If all files are relevant, respond with a list of all files.
    Order the files by how much assistant still needs to know about them to complete the user's task, most important first.
    `;

    const format = {
      type: 'array',
      description: 'Array of relevant file paths',
      items: {
        type: 'string',
      },
    };

    const result = await context.chatController.backgroundTask.run({
      prompt,
      format,
      model: context.chatController.settings.selectedModel,
    });

    return result;
  }

  async readFile(filePath) {
    try {
      const stats = await fs.promises.stat(filePath);
      if (!isTextFile(filePath) || stats.size > MAX_FILE_SIZE) {
        console.error(`Skipped file (non-text or too large): ${filePath}`);
        return null;
      }
      const content = await fs.promises.readFile(filePath, 'utf8');
      return this.addLineNumbers(content);
    } catch (error) {
      console.error(`Error reading file ${filePath}:`, error);
      return null;
    }
  }

  addLineNumbers(content) {
    const lines = content.split('\n');
    const paddedLines = lines.map((line, index) => {
      const lineNumber = (index + 1).toString().padStart(4, ' ');
      return `${lineNumber}|${line}`;
    });
    content = paddedLines.join('\n');
    return content;
  }
}

module.exports = RelevantFiles;
