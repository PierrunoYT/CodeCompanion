const context = require('../context');
const os = require('os');
const fs = require('graceful-fs');
const path = require('path');
const ProjectController = require('../project_controller');
const { toolDefinitions, previewMessageMapping, getCodeToReplace } = require('../tools/tools');
const { isFileExists, normalizedFilePath } = require('../utils');

class Agent {
  constructor(currentProject) {
    this.currentWorkingDir = os.homedir();
    this.projectState = {};
    this.projectController = new ProjectController(currentProject);
    this.pendingDecision = null;
    this.lastToolCall = null;
  }

  async runAgent(apiResponseMessage) {
    if (context.chatController.stopProcess || !apiResponseMessage) {
      return;
    }

    try {
      const toolCalls = apiResponseMessage.tool_calls;
      if (apiResponseMessage.content) {
        context.chatController.chat.addFrontendMessage('assistant', apiResponseMessage.content);
      }
      context.chatController.chat.addBackendMessage('assistant', apiResponseMessage.content, toolCalls);

      if (toolCalls && toolCalls.length > 0) {
        const { decision, reflectMessage } = await this.runTools(toolCalls);

        if (decision !== 'reject') {
          await context.chatController.process('', false, reflectMessage);
        }
      }
    } catch (error) {
      context.chatController.handleError(error);
    }
  }

  async runTools(toolCalls) {
    let isUserRejected = false;

    for (const toolCall of toolCalls) {
      const functionName = toolCall.function.name;
      const allowedToExecute = await this.isToolAllowedToExecute(toolCall);
      if (allowedToExecute === false) {
        continue;
      }

      await this.showToolCallPreview(toolCall);
      const decision = await this.waitForDecision(functionName, toolCall);
      this.lastToolCall = toolCall;

      if (decision === 'approve') {
        const functionCallResult = await this.callFunction(toolCall);
        if (functionCallResult) {
          context.chatController.chat.addBackendMessage('tool', functionCallResult, null, functionName, toolCall.id);
        } else {
          context.viewController.updateLoadingIndicator(false);
        }
      } else if (decision === 'reject') {
        isUserRejected = true;
        context.chatController.chat.addFrontendMessage('error', 'Action was rejected');
        context.chatController.chat.addBackendMessage(
          'tool',
          `User rejected tool call: \n ${JSON.stringify(toolCall, null, 2)}`,
          null,
          functionName,
          toolCall.id,
        );
        return { decision: 'reject', reflectMessage: null };
      } else if (decision === 'reflect') {
        return { decision: 'reflect', reflectMessage: toolCall };
      }
    }

    this.projectController.git.updateTabIcon();
    return { decision: 'approve', reflectMessage: null };
  }

  async isToolAllowedToExecute(toolCall) {
    // Don't allow code replacement or writing to files if file is not in chat context
    const toolsToCheck = ['create_or_overwrite_file', 'replace_code'];
    const toolName = toolCall.function.name;

    if (!toolsToCheck.includes(toolName)) {
      return true;
    }

    const args = this.parseArguments(toolCall.function.arguments);
    const filePath = await normalizedFilePath(args.targetFile);
    const fileExists = await isFileExists(filePath);

    // allow creating file if it doesn't exist
    if (toolName === 'create_or_overwrite_file' && !fileExists) {
      return true;
    }

    // check if file is in chat context
    const chatContextFiles = context.chatController.chat.chatContextBuilder.taskRelevantFiles;
    const fileInChatContext = chatContextFiles.includes(filePath);

    if (fileInChatContext === false) {
      console.error('Tool rejected', toolCall);
      if (fileExists) {
        context.chatController.chat.chatContextBuilder.taskRelevantFiles.push(filePath);
      }
    }

    return fileInChatContext;
  }

  // Called by the approve / reject / reflect buttons.
  decide(decision) {
    if (this.pendingDecision) {
      this.pendingDecision(decision);
    }
  }

  async waitForDecision(functionName, toolCall) {
    if (
      this.isToolCallRepeated(toolCall) ||
      (context.chatController.settings.approvalRequired &&
        toolDefinitions.find((tool) => tool.name === functionName).approvalRequired)
    ) {
      document.getElementById('messageInput').disabled = true;
      document.getElementById('approval_buttons').removeAttribute('hidden');
      return new Promise((resolve) => {
        this.pendingDecision = (decision) => {
          this.pendingDecision = null;
          document.getElementById('approval_buttons').setAttribute('hidden', true);
          document.getElementById('messageInput').disabled = false;
          document.getElementById('messageInput').focus();
          resolve(decision);
        };
      });
    } else {
      return Promise.resolve('approve');
    }
  }

  isToolCallRepeated(toolCall) {
    if (!this.lastToolCall) return false;
    return JSON.stringify(toolCall) === JSON.stringify(this.lastToolCall);
  }

  async callFunction(toolCall) {
    context.viewController.updateLoadingIndicator(true);
    const functionName = toolCall.function.name;
    const args = this.parseArguments(toolCall.function.arguments);
    let result = '';

    try {
      const tool = toolDefinitions.find((tool) => tool.name === functionName);
      if (tool) {
        result = await tool.executeFunction(args);
      } else {
        throw new Error(`Tool with name ${functionName} not found.`);
      }
    } catch (error) {
      console.error(error);
      context.chatController.chat.addFrontendMessage('error', `Error occurred. ${error.message}`);
      result = `Error: ${error.message}`;
    } finally {
      context.viewController.updateLoadingIndicator(false);
      return result;
    }
  }

  parseArguments(args) {
    if (typeof args === 'object' && args !== null) {
      return args;
    }

    if (typeof args === 'string') {
      try {
        return JSON.parse(args);
      } catch (error) {
        console.warn('Failed to parse arguments:', error);
        return args; // Return original string if parsing fails
      }
    }

    console.warn('Unexpected argument type:', typeof args);
    return args; // Return original for any other type
  }

  async showToolCallPreview(toolCall) {
    const functionName = toolCall.function.name;
    const args = this.parseArguments(toolCall.function.arguments);
    const preview = await previewMessageMapping(functionName, args);

    context.chatController.chat.addFrontendMessage('assistant', `${preview.message}\n${preview.code}`);
  }
}

module.exports = Agent;
