const axios = require('axios');
const { Readability } = require('@mozilla/readability');
const { JSDOM } = require('jsdom');
const context = require('../../context');
const GoogleSearch = require('../google_search');
const { contextualCompress } = require('../contextual_compressor');
const { openFileLink } = require('../helpers');

async function searchCode({ query, rerank = true, count = 10 }) {
  let frontendMessage = '';
  let backendMessage = '';
  let uniqueFiles = [];

  let results = await context.chatController.agent.projectController.searchEmbeddings({ query, count, rerank });

  if (results && results.length > 0) {
    const files = results.map((result) => result.filePath);
    uniqueFiles = [...new Set(files)];
    frontendMessage = `Checked ${uniqueFiles.length} files:<br>${await Promise.all(uniqueFiles.map(async (filePath) => await openFileLink(filePath))).then((fileLinks) => fileLinks.join('<br>'))}`;
    backendMessage = JSON.stringify(results);
    context.chatController.chat.addFrontendMessage('function', frontendMessage);
    return backendMessage;
  }

  const noResultsMessage = `No results found`;
  context.chatController.chat.addFrontendMessage('function', noResultsMessage);
  return noResultsMessage;
}

async function googleSearch({ query }) {
  const searchAPI = new GoogleSearch();
  const googleSearchResults = await searchAPI.singleSearch(query);

  const promises = googleSearchResults.map(async (result) => {
    const content = await fetchAndParseUrl(result.link);
    if (content) {
      result.content = JSON.stringify(content);
    }
    return result;
  });
  let results = await Promise.all(promises);
  results = results.filter((result) => result.content);
  let compressedResult;
  let firstCompressedResult;

  for (const result of results) {
    compressedResult = await contextualCompress(query, result.content);
    if (!firstCompressedResult) firstCompressedResult = compressedResult;

    // return first result if it meets the condition
    if (await checkIfAnswersQuery(query, compressedResult)) {
      context.chatController.chat.addFrontendMessage(
        'function',
        `Checked websites:<br>${results.map((result) => `<a href="${result.link}" class="text-truncate ms-2">${result.link}</a>`).join('<br>')}`,
      );
      return JSON.stringify(compressedResult);
    }
  }

  // Return first compressed result if no result meets the condition
  context.chatController.chat.addFrontendMessage(
    'function',
    `Checked websites:<br>${results.map((result) => `<a href="${result.link}" class="text-truncate ms-2">${result.link}</a>`).join('<br>')}`,
  );
  return JSON.stringify(firstCompressedResult);
}

async function fetchAndParseUrl(url) {
  try {
    const response = await axios.get(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537',
      },
      timeout: 5000,
    });
    const html = response.data;
    const doc = new JSDOM(html, { url: url }).window.document;
    const reader = new Readability(doc);
    const article = reader.parse();
    return article.textContent;
  } catch (error) {
    return;
  }
}

async function checkIfAnswersQuery(query, searchResult) {
  const format = {
    type: 'boolean',
    result: 'true or false',
  };
  const prompt = `
I am searching the web for this query: '${query}'
The search result is:

${JSON.stringify(searchResult)}

Does this result answer the search query question?
Respond with a boolean value: "true" or "false"`;
  const result = await context.chatController.backgroundTask.run({ prompt, format });

  return result !== false;
}

async function unifiedSearch({ type, query }) {
  switch (type) {
    case 'codebase':
      const codebaseResult = await searchCode({ query });
      return `Codebase search result for "${query}":\n${codebaseResult}`;
    case 'google':
      const result = await googleSearch({ query });
      return `Google search result for "${query}":\n${result}`;
    default:
      return 'Invalid search type specified.';
  }
}

module.exports = { unifiedSearch };
