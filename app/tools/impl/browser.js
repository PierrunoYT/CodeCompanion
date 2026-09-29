const context = require('../../context');

async function browser({ include_screenshot, url }) {
  let userScreenshotMessage = '';
  let assistantScreenshotMessage = '';

  context.viewController.updateLoadingIndicator(true, 'Waiting for the page to load...');
  context.viewController.activateTab('browser-tab');
  const consoleOutput = await context.chatController.browser.loadUrl(url);

  if (include_screenshot) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await context.chatController.browser.handleSreenshot();
    userScreenshotMessage = ` and took a screenshot of`;
    assistantScreenshotMessage = `\nScreenshot of the webpage was taken and attached in the user message`;
  }
  context.chatController.chat.addFrontendMessage('function', `Opened URL ${userScreenshotMessage}: ${url}`);
  return `Browser loaded URL: ${url}\n<console_output>${consoleOutput}</console_output>${assistantScreenshotMessage}`;
}

module.exports = { browser };
