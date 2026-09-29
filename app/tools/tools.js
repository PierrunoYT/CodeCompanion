const context = require('../context');
const fs = require('graceful-fs');
const { normalizedFilePath } = require('../utils');
const { generateDiff } = require('./code_diff');
const { openFileLink } = require('./helpers');
const { createFile, replaceInFile, codeAfterReplace, readFile } = require('./impl/files');
const { shell } = require('./impl/shell');
const { browser } = require('./impl/browser');
const { unifiedSearch } = require('./impl/search');

const toolDefinitions = [
  {
    name: 'browser',
    description:
      'Allows to interact with the browser, Use it to open webpage for a user to see, to refresh the page after making changes or to capture console output or a screenshot of the page',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description:
            'Use full URL, including protocol (e.g., http://, https://). For local files like index.html, use file:// protocol and absolute file path',
        },
        include_screenshot: {
          type: 'boolean',
          description:
            'Set to true only if you or the user need a screenshot of the page. Avoid taking a screenshot unless some problem need to be solved',
          default: false,
        },
      },
    },
    executeFunction: browser,
    enabled: true,
    approvalRequired: false,
  },
  {
    name: 'create_or_overwrite_file',
    description: 'Create or overwrite a file with new content',
    parameters: {
      type: 'object',
      properties: {
        targetFile: {
          type: 'string',
          description: 'File path',
        },
        createText: {
          type: 'string',
          description: `Output the entire completed source code for a file in a single step. Always use correct indentation and new lines.`,
        },
      },
    },
    executeFunction: createFile,
    enabled: true,
    approvalRequired: true,
  },
  {
    name: 'replace_code',
    description: 'Replace a portion of a file with new content',
    parameters: {
      type: 'object',
      properties: {
        targetFile: {
          type: 'string',
          description: 'Path to the file to be modified.',
        },
        startLineNumber: {
          type: 'integer',
          description: 'The line number where the replacement should start (inclusive).',
        },
        endLineNumber: {
          type: 'integer',
          description:
            'The line number where the replacement should end (inclusive). Must be greater than startLineNumber.',
        },
        replaceWith: {
          type: 'string',
          description:
            'New content to replace the specified lines. Ensure correct indentation for each new line of code inserted.',
        },
      },
    },
    executeFunction: replaceInFile,
    enabled: true,
    approvalRequired: true,
  },
  {
    name: 'read_file',
    description: 'Read files. Do not read files that are listed in the <relevant_files_contents> section.',
    parameters: {
      type: 'object',
      properties: {
        targetFile: {
          type: 'string',
        },
      },
    },
    executeFunction: readFile,
    enabled: true,
    approvalRequired: false,
  },
  {
    name: 'run_shell_command',
    description: 'Run a single shell command',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description:
            'Single shell command to run. DO NOT combine multiple shell commands into a single command with "&&"',
        },
        background: {
          type: 'boolean',
          description:
            'When set to false, will hang until command finished executing. Set to true always when you need to run a webserver right before opening a browser',
          default: false,
        },
      },
    },
    executeFunction: shell,
    enabled: true,
    approvalRequired: true,
  },
  {
    name: 'search',
    description: 'Semantic search that can perform codebase search or Google search',
    parameters: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['codebase', 'google'],
          description:
            'Type of search to perform. Use codebase to search existing code in project with many files. Use Google only to find latest information or when asked by user. Do not use Google to search for best practices, code examples, libraries, etc.',
        },
        query: {
          type: 'string',
          description: `Long, descriptive natural language search query`,
        },
      },
    },
    executeFunction: unifiedSearch,
    enabled: true,
    approvalRequired: false,
  },
  {
    name: 'task_planning_done',
    description: 'Indicate that task planning is done and ready to start implementation',
    parameters: {
      type: 'object',
      properties: {},
    },
    executeFunction: taskPlanningDone,
    enabled: false,
    approvalRequired: false,
  },
];

async function previewMessageMapping(functionName, args) {
  let codeDiff = '';
  let fileLink = '';
  let browserMessage = '';

  if (functionName === 'create_or_overwrite_file') {
    const newFile = await normalizedFilePath(args.targetFile);
    if (fs.existsSync(newFile)) {
      const oldContent = fs.readFileSync(newFile, 'utf8');
      codeDiff = generateDiff(oldContent, args.createText, newFile, newFile);
    }
  }

  if (functionName === 'replace_code') {
    const { newContent, oldContent } = await codeAfterReplace(args);
    codeDiff = generateDiff(oldContent, newContent, args.targetFile, args.targetFile);
  }

  if (args.targetFile) {
    fileLink = await openFileLink(args.targetFile);
  }

  const mapping = {
    browser: {
      message: '',
      code: '',
    },
    create_or_overwrite_file: {
      message: `Creating a file ${args.targetFile}`,
      code: codeDiff ? `\n\`\`\`diff\n${codeDiff}\n\`\`\`` : `\n\`\`\`${args.createText}\n\`\`\``,
    },
    read_file: {
      message: '',
      code: '',
    },
    replace_code: {
      message: `Updating code in ${fileLink}:`,
      code: `\n\`\`\`diff\n${codeDiff}\n\`\`\``,
    },
    run_shell_command: {
      message: 'Executing shell command:',
      code: `\n\n\`\`\`console\n${args.command}\n\`\`\``,
    },
    search: {
      message: `Searching ${args.type} for '${args.query}'`,
      code: '',
    },
    task_planning_done: {
      message: 'Task planning is done.',
      code: '',
    },
  };
  return mapping[functionName];
}

function taskPlanningDone() {
  context.chatController.chat.chatContextBuilder.taskNeedsPlan = false;
  return 'Task planning is done.';
}

function getEnabledTools(filterFn) {
  return toolDefinitions
    .filter(filterFn)
    .map(({ name, description, parameters }) => ({ name, description, parameters }));
}

function allEnabledTools() {
  return getEnabledTools((tool) => tool.enabled);
}

function planningTools() {
  const tools = getEnabledTools((tool) => tool.enabled && !tool.approvalRequired);
  const taskPlanningDoneTool = toolDefinitions.find((tool) => tool.name === 'task_planning_done');
  tools.push({
    name: taskPlanningDoneTool.name,
    description: taskPlanningDoneTool.description,
    parameters: taskPlanningDoneTool.parameters,
  });

  return tools;
}

module.exports = {
  allEnabledTools,
  planningTools,
  toolDefinitions,
  previewMessageMapping,
};
