// Explicit application context. renderer.js registers the top-level controllers here so that
// modules can reach them via `require('./context')` instead of relying on implicit globals.
//
//   context.chatController  - ChatController (chat, agent, models, terminal, browser)
//   context.viewController  - ViewController (DOM helpers)
module.exports = {
  chatController: null,
  viewController: null,
};
