const Store = require('electron-store');

// Shared electron-store instance (settings, projects, chat history, embeddings).
module.exports = new Store();
