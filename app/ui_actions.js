const _ = require('lodash');
const context = require('./context');

// Clickable elements in dynamically generated HTML declare what they do with data attributes instead
// of inline onclick handlers, so that untrusted HTML (model output) can be sanitized without losing
// the app's own links and buttons:
//
//   <a href="#" data-action="open-file" data-arg="C:\project\file.js">file.js</a>
//
// A single delegated click listener (see ViewController.handleClick) calls dispatch().
const actions = {
  'open-file': (filePath) => context.viewController.openFileInIDE(filePath),
  'copy-message': (id) => context.chatController.chat.copyFrontendMessage(Number(id)),
  'delete-messages-after': (id) => context.chatController.chat.deleteMessagesAfterId(Number(id)),
  'restore-chat': (id) => context.chatController.chat.history.restoreChat(id),
  'delete-chat': (id) => context.chatController.chat.history.delete(id),
  'delete-all-chats': () => context.chatController.chat.history.deleteAll(),
  'open-project': (projectPath) => context.chatController.agent.projectController.openProject(projectPath),
  'project-instructions': (projectPath) =>
    context.chatController.agent.projectController.showInstructionsModal(projectPath),
  'select-directory': () => context.viewController.selectDirectory(),
  'git-commit': () => context.chatController.agent.projectController.git?.commit(),
  'git-refresh': () => context.chatController.agent.projectController.git?.renderUI(),
  'git-show-file': (filePath) => context.chatController.agent.projectController.git?.showFileChanges(filePath),
  'git-discard': (filePath) => context.chatController.agent.projectController.git?.discardChange(filePath),
};

// Returns the attribute string to put on an element, e.g. actionAttrs('open-file', p).
function actionAttrs(name, arg) {
  if (!(name in actions)) {
    throw new Error(`Unknown UI action: ${name}`);
  }
  const argAttr = arg === undefined ? '' : ` data-arg="${_.escape(String(arg))}"`;
  return `data-action="${name}"${argAttr}`;
}

// Runs the action declared on the closest [data-action] ancestor of the clicked element.
// Returns true if an action was handled.
function dispatch(target) {
  const element = target.closest && target.closest('[data-action]');
  if (!element) return false;

  const action = actions[element.dataset.action];
  if (!action) return false;

  action(element.dataset.arg);
  return true;
}

module.exports = { actionAttrs, dispatch };
