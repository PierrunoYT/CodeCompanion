const path = require('path');
const fs = require('graceful-fs');
const context = require('../../context');
const { normalizedFilePath } = require('../../utils');
const { generateDiff } = require('../code_diff');
const { openFileLink, respondTargetFileNotProvided } = require('../helpers');

async function createFile({ targetFile, createText }) {
  if (!targetFile) {
    return respondTargetFileNotProvided();
  }

  const filePath = await normalizedFilePath(targetFile);
  if (!fs.existsSync(filePath)) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }
  fs.writeFileSync(filePath, createText);
  context.chatController.chat.addFrontendMessage('function', `File ${await openFileLink(filePath)} created successfully`);

  return `File '${targetFile}' created successfully`;
}

async function replaceInFile({ targetFile, startLineNumber, endLineNumber, replaceWith }) {
  if (!targetFile) {
    return respondTargetFileNotProvided();
  }

  const filePath = await normalizedFilePath(targetFile);
  if (!fs.existsSync(filePath)) {
    const doesntExistMessage = `File with filepath '${targetFile}' does not exist`;
    context.chatController.chat.addFrontendMessage('function', doesntExistMessage);
    return doesntExistMessage;
  }

  if (startLineNumber < 1 || startLineNumber > endLineNumber) {
    const invalidRangeMessage = `Invalid line range: ${startLineNumber}-${endLineNumber}`;
    context.chatController.chat.addFrontendMessage('function', invalidRangeMessage);
    return invalidRangeMessage;
  }

  const { newContent, oldContent } = await codeAfterReplace({
    targetFile,
    startLineNumber,
    endLineNumber,
    replaceWith,
  });
  const codeDiff = generateDiff(oldContent, newContent, filePath, filePath);
  fs.writeFileSync(filePath, newContent);
  const successMessage = `File ${await openFileLink(filePath)} updated successfully.`;
  context.chatController.chat.addFrontendMessage('function', successMessage);

  return `File ${filePath} updated successfully.\n<code diff>${codeDiff}</code diff>`;
}

async function codeAfterReplace({ targetFile, startLineNumber, endLineNumber, replaceWith }) {
  const filePath = await normalizedFilePath(targetFile);
  let oldContent = fs.readFileSync(filePath, 'utf8');
  const lines = oldContent.split('\n');
  const beforeLines = lines.slice(0, startLineNumber - 1);
  const afterLines = lines.slice(endLineNumber);
  const newContent = [...beforeLines, replaceWith, ...afterLines].join('\n');

  return {
    newContent,
    oldContent,
  };
}

async function readFile({ targetFile }) {
  if (!targetFile) {
    return respondTargetFileNotProvided();
  }

  const filePath = await normalizedFilePath(targetFile);
  if (!fs.existsSync(filePath)) {
    const doesntExistMessage = `File with filepath '${targetFile}' does not exist`;
    context.chatController.chat.addFrontendMessage('function', doesntExistMessage);
    return doesntExistMessage;
  }

  context.chatController.chat.addFrontendMessage('function', `Read ${await openFileLink(filePath)} file`);

  return `File "${filePath}" was read.`;
}

module.exports = { createFile, replaceInFile, codeAfterReplace, readFile };
