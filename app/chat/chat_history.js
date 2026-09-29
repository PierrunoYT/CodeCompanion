const context = require('../context');
const store = require('../store');
const { v4: uuidv4 } = require('uuid');

const saveChatModal = new bootstrap.Modal(document.getElementById('saveChatModal'));

class ChatHistory {
  save() {
    const id = uuidv4();
    const date = new Date().toISOString();
    const titleElement = document.getElementById('chatTitle');
    const title = titleElement.value || 'Untitled';
    titleElement.value = '';

    const record = {
      id,
      title,
      date,
      chat: {
        frontendMessages: context.chatController.chat.frontendMessages,
        backendMessages: context.chatController.chat.backendMessages,
        currentId: context.chatController.chat.currentId,
        lastBackendMessageId: context.chatController.chat.lastBackendMessageId,
        taskTitle: context.chatController.chat.taskTitle,
        task: context.chatController.chat.task,
      },
      workingDir: context.chatController.agent.currentWorkingDir,
      selectedModel: context.chatController.settings.selectedModel,
    };

    const chatHistory = store.get('chatHistory', {});
    chatHistory[id] = record;
    store.set('chatHistory', chatHistory);
    saveChatModal.hide();
    context.viewController.updateFooterMessage('Chat saved.');
  }

  delete(id) {
    const chatHistory = store.get('chatHistory', {});
    delete chatHistory[id];
    store.set('chatHistory', chatHistory);
    this.load();
  }

  retrieveAll() {
    const records = Object.values(store.get('chatHistory', {}));
    return records.sort((a, b) => new Date(b.date) - new Date(a.date));
  }

  async restoreChat(id) {
    const record = store.get('chatHistory', {})[id];
    if (record) {
      context.chatController.saveSetting('selectedModel', record.selectedModel);
      Object.assign(context.chatController.chat, record.chat);
      context.chatController.chat.updateUI();
      context.chatController.agent.projectController.openProject(record.workingDir);
    }
  }

  deleteAll() {
    store.set('chatHistory', {});
    this.load();
  }

  renderUI() {
    const records = this.retrieveAll();

    if (!records.length) {
      return '<div class="text-muted">No history records found.</div>';
    }

    const recordRows = records
      .map(
        (record) => `
        <div class="list-group-item list-group-item-action d-flex justify-content-between align-items-center">
          <a href="#" onclick="event.preventDefault(); chatController.chat.history.restoreChat('${record.id}')" class="text-decoration-none text-body text-truncate">
            <i class="bi bi-chat-left me-2"></i>
            ${record.title}
          </a>
          <button class="btn btn-sm" onclick="event.preventDefault(); chatController.chat.history.delete('${record.id}')"><i class="bi bi-trash"></i></button>
        </div>
    `,
      )
      .join('');

    return `
    <div class="d-flex justify-content-end mb-3">
      <button onclick="chatController.chat.history.deleteAll()" class="btn btn-sm btn-outline-secondary"><i class="bi bi-trash"></i> Delete all</button>
    </div>
    ${recordRows}
  `;
  }

  load() {
    document.getElementById('chatHistory').innerHTML = this.renderUI();
  }

  showModal() {
    if (context.chatController.chat.isEmpty()) {
      context.viewController.updateFooterMessage('Nothing to save.');
      return;
    }
    saveChatModal.show();
    const chatTitleInput = document.getElementById('chatTitle');
    chatTitleInput.value = context.chatController.chat.taskTitle || '';
    chatTitleInput.focus();
  }
}

module.exports = ChatHistory;
