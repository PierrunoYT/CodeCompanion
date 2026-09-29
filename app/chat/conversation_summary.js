const context = require('../context');
const { getTokenCount } = require('../utils');

const MAX_SUMMARY_TOKENS = 2000;
const SUMMARIZE_MESSAGES_THRESHOLD = 6; // Last n message will be left as is

// Keeps a rolling summary of older backend messages so the prompt does not grow without bound.
class ConversationSummary {
  constructor(chat) {
    this.chat = chat;
    this.lastSummarizedMessageID = 0;
    this.pastSummarizedMessages = '';
  }

  async build() {
    let allMessagesText = '';
    const backendMessages = this.chat.backendMessages;

    // remove image data from content
    const preprocessedMessages = backendMessages.map((message) => {
      if (Array.isArray(message.content)) {
        const filteredContent = message.content.filter((content) => content.type !== 'image_url');
        return { ...message, content: filteredContent };
      }
      return message;
    });
    const messagesToSummarize = preprocessedMessages.slice(0, -SUMMARIZE_MESSAGES_THRESHOLD);
    let lastSummarizedId = this.lastSummarizedMessageID;
    const notSummarizedMessages = messagesToSummarize
      .filter((message) => message.id > this.lastSummarizedMessageID)
      .reduce((acc, message) => {
        acc += `${this.formatMessage(message)},\n`;
        lastSummarizedId = message.id;
        return acc;
      }, '');

    allMessagesText = this.pastSummarizedMessages + '\n\n' + notSummarizedMessages; // up to -SUMMARIZE_MESSAGES_THRESHOLD

    if (getTokenCount(notSummarizedMessages) > MAX_SUMMARY_TOKENS) {
      this.compress(allMessagesText).then((summarizedMessages) => {
        this.pastSummarizedMessages = summarizedMessages;
        this.lastSummarizedMessageID = lastSummarizedId;
      });
    }

    const lastNMessages = preprocessedMessages.slice(-SUMMARIZE_MESSAGES_THRESHOLD);
    let messagesToAdd = lastNMessages.filter((message) => message.id > this.lastSummarizedMessageID);
    if (messagesToAdd.length > 0 && messagesToAdd[messagesToAdd.length - 1].role === 'user') {
      messagesToAdd.pop(); // Remove the last message if it's from a user
    }
    messagesToAdd.forEach((message) => {
      allMessagesText += `${this.formatMessage(message, false)},\n`;
    });

    const summary =
      allMessagesText.trim().length > 0
        ? `\n<conversation_history>\n[${allMessagesText}]\n</conversation_history>`
        : '';

    return summary;
  }

  formatMessage(message, removeCodeDiff = true) {
    let messageContent = message.content;
    let content = [];

    if (messageContent) {
      if (removeCodeDiff && messageContent && messageContent.includes('<code diff>')) {
        messageContent = messageContent.replace(/<code diff>[\s\S]*<\/code diff>/g, '');
      }
      content.push({
        type: message.role === 'tool' ? 'tool_result' : 'text',
        content: messageContent,
      });
    }
    if (message.tool_calls) {
      message.tool_calls.forEach((toolCall) => {
        content.push({
          type: 'tool_use',
          name: toolCall.function.name,
        });
      });
    }
    const role = message.role === 'tool' ? 'user' : message.role;
    const result = { role, content };
    return JSON.stringify(result, null, 2);
  }

  async compress(messages) {
    const prompt = `
    Compress conversation_history below without losing important information.
    Compress with at least .75 or more compression ratio.
    
    Summarization rules:
     - Preserve roles, tool names, file names
     - Preserve all important information and code snippets
     - Leave messages with "user" role word for word without alteration
     - Make sure to remove any duplicate or similar actions or information that repeats
     - Compress terminal output and only leave most important information
     - Compress "content", only keep the most important information, shorten it as much as possible
     - Compress top (older) messages more, then lower (newer) messages. Compress long assistant messages into maximum 3 sentences
     - Keep plan for the task as is (can be more than 3 sentences), make sure to preserve all messages that have requirements fully

    Respond with compressed conversation_history without wrapping XML tag, in exactly the same JSON schema format as provided in the original.

    <conversation_history>
    [
      ${messages}
    ]
    </conversation_history>`;
    const format = {
      type: 'string',
      result: 'Summary of the conversation',
    };
    let summary = await context.chatController.backgroundTask.run({
      prompt,
      format,
      model: context.chatController.settings.selectedModel,
    });

    if (summary) {
      // Remove first "[" if present
      summary = summary.replace(/^\s*\[/, '');
      // Replace last "]" with "," if present
      summary = summary.replace(/\]\s*$/, ',');
      console.log('Summarized message history:', summary);
      return summary;
    } else {
      return messages;
    }
  }
}

module.exports = ConversationSummary;
