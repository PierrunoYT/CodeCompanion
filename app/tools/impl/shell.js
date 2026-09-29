const context = require('../../context');

async function shell({ command, background }) {
  context.viewController.updateLoadingIndicator(true, 'Executing shell command ...  (click Stop to cancel or use Ctrl+C)');
  let commandResult;
  if (background === true) {
    context.chatController.terminalSession.executeShellCommand(command);
    return 'Command started in the background';
  } else {
    commandResult = await context.chatController.terminalSession.executeShellCommand(command);
  }
  // Preserve first 5 lines and last 95 lines if more than 100 lines
  const lines = commandResult.split('\n');
  if (lines.length > 100) {
    const firstFive = lines.slice(0, 5);
    const lastNinetyFive = lines.slice(-95);
    commandResult = [...firstFive, '(some command output omitted)...', ...lastNinetyFive].join('\n');
  }
  if (commandResult.length > 5000) {
    commandResult = commandResult.substring(commandResult.length - 5000);
    commandResult = `(some command output omitted)...\n${commandResult}`;
  }
  commandResult = commandResult.replace(command, '');
  commandResult = `Command executed: '${command}'\nOutput:\n'${commandResult ? commandResult : 'command executed successfully. Terminal command output was empty.'}'`;
  context.viewController.updateLoadingIndicator(false);

  return commandResult;
}

module.exports = { shell };
