const context = require('../context');
const _ = require('lodash');
const ConversationSummary = require('./conversation_summary');
const ProjectState = require('./project_state');
const RelevantFiles = require('./relevant_files');
const {
  PLAN_PROMPT_TEMPLATE,
  TASK_EXECUTION_PROMPT_TEMPLATE,
  FINISH_TASK_PROMPT_TEMPLATE,
} = require('../static/prompts');
const { getSystemInfo } = require('../utils');

// Assembles the two messages (system + user) sent to the model on every turn.
class ChatContextBuilder {
  constructor(chat) {
    this.chat = chat;
    this.summary = new ConversationSummary(chat);
    this.projectState = new ProjectState();
    this.relevantFiles = new RelevantFiles(chat, {
      projectState: this.projectState,
      summary: this.summary,
      describeTask: () => this.addTaskMessage(),
    });
    this.taskNeedsPlan = false;
    this.isComplexTask = false;
  }

  // Files whose contents are kept in the prompt; the agent only edits files that are listed here.
  get taskRelevantFiles() {
    return this.relevantFiles.taskRelevantFiles;
  }

  set taskRelevantFiles(files) {
    this.relevantFiles.taskRelevantFiles = files;
  }

  async buildMessages(userMessage, reflectMessage = null) {
    this.backendMessages = this.chat.backendMessages.map((message) => _.omit(message, ['id']));

    return [await this.addSystemMessage(), await this.addUserMessage(userMessage, reflectMessage)];
  }

  async addUserMessage(userMessage, reflectMessage) {
    const conversationSummary = await this.summary.build();
    const lastUserMessage = this.addLastUserMessage(userMessage);
    const reflectMessageResult = this.addReflectMessage(reflectMessage);
    const relevantSourceCodeInformation = await this.relevantSourceCodeInformation();

    const textContent = [
      this.addTaskMessage(),
      conversationSummary,
      lastUserMessage,
      relevantSourceCodeInformation,
      reflectMessageResult,
    ]
      .filter(Boolean)
      .join('\n');

    let content;

    const imageMessages = this.getImageMessages();
    if (imageMessages.length > 0) {
      content = [...imageMessages, { type: 'text', text: textContent }];
    } else {
      content = textContent;
    }

    return {
      role: 'user',
      content,
    };
  }

  getImageMessages() {
    const imageMessages = this.backendMessages.filter(
      (message) => Array.isArray(message.content) && message.content.some((content) => content.type === 'image_url'),
    );

    return imageMessages.map((message) => {
      return message.content.find((content) => content.type === 'image_url');
    });
  }

  async addSystemMessage() {
    let systemMessage;

    if (
      (this.taskNeedsPlan && this.chat.countOfUserMessages() === 0) ||
      (this.chat.isEmpty() && (await this.isTaskNeedsPlan()))
    ) {
      this.taskNeedsPlan = true;
      this.isComplexTask = true;
      systemMessage = PLAN_PROMPT_TEMPLATE;
    } else {
      this.taskNeedsPlan = false;
      systemMessage = TASK_EXECUTION_PROMPT_TEMPLATE;
    }

    if (this.chat.backendMessages.length > 7 || !this.isComplexTask) {
      systemMessage += `\n\n${FINISH_TASK_PROMPT_TEMPLATE}`;
    }

    systemMessage += this.addProjectCustomInstructionsMessage();
    systemMessage = this.fromTemplate(systemMessage, '{osName}', getSystemInfo());
    systemMessage = this.fromTemplate(systemMessage, '{shellType}', context.chatController.terminalSession.shellType);

    return {
      role: 'system',
      content: systemMessage,
    };
  }

  async isTaskNeedsPlan() {
    const prompt = `
    Task:
    "${this.chat.task}"\n
    Will this user task need to be brainstormed and planned before execution? Respond false if this is a simple task that involves only a few commands or one file manipulation.`;

    const format = {
      type: 'boolean',
      result: 'true or false',
    };

    const result = await context.chatController.backgroundTask.run({
      prompt,
      format,
      model: context.chatController.settings.selectedModel,
    });

    return result;
  }

  addTaskMessage() {
    return `<task>\n${this.chat.task}\n</task>\n`;
  }

  addProjectCustomInstructionsMessage() {
    const projectCustomInstructions = context.chatController.agent.projectController.getCustomInstructions();
    if (!projectCustomInstructions) {
      return '';
    } else {
      return `\n\n${projectCustomInstructions}`;
    }
  }

  async relevantSourceCodeInformation() {
    const projetState = await this.projectState.toText();
    const relevantFilesAndFoldersToUserMessages = await this.relevantFiles.suggestions();
    const relevantFilesContents = await this.relevantFiles.contents();

    return `${projetState}${relevantFilesAndFoldersToUserMessages}${relevantFilesContents}`;
  }

  addLastUserMessage(userMessage) {
    if (!userMessage) {
      userMessage = '';
    }

    return userMessage ? `<user>${userMessage}</user>\n` : '';
  }

  addReflectMessage(reflectMessage) {
    if (!reflectMessage) {
      return null;
    }

    return `
      "assistant" proposed this change:
      
      ${JSON.stringify(reflectMessage, null, 2)}
      
      This can be improved.
      First step by step explain how code/commamnd can be improved or fixed, what bugs it has, what was not implemented correctly or fully, and what may not work.
      Then run the same tool but with improved code/command based on your explanation. Only provide code/command in the tool not in message content`;
  }

  fromTemplate(content, placeholder, value) {
    const regex = new RegExp(placeholder, 'g');
    return content.replace(regex, value);
  }
}

module.exports = ChatContextBuilder;
