const path = require('path');
const context = require('../context');
const { normalizedFilePath } = require('../utils');

async function openFileLink(filepath) {
  try {
    let absolutePath = path.normalize(filepath);

    if (!path.isAbsolute(absolutePath)) {
      if (context.chatController.agent.projectController.currentProject) {
        absolutePath = path.join(context.chatController.agent.projectController.currentProject.path, absolutePath);
      } else {
        absolutePath = await normalizedFilePath(absolutePath);
      }
    }

    let filename;
    if (context.chatController.agent.projectController.currentProject) {
      filename = path.relative(context.chatController.agent.projectController.currentProject.path, absolutePath);
    } else {
      filename = path.relative(context.chatController.agent.currentWorkingDir, absolutePath);
    }

    return `<a href="#" onclick="event.preventDefault(); viewController.openFileInIDE('${absolutePath.replace(/\\/g, '\\\\')}')">${filename}</a>`;
  } catch (error) {
    console.error(error);
    return filepath;
  }
}

function respondTargetFileNotProvided() {
  context.chatController.chat.addFrontendMessage('function', 'File name was not provided.');

  return 'Please provide a target file name in a correct format.';
}

module.exports = { openFileLink, respondTargetFileNotProvided };
