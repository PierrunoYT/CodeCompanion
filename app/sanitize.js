const DOMPurify = require('dompurify');

// The renderer runs with Node integration, so any script that reaches the DOM can run arbitrary code.
// Everything that may contain model output, file contents or web content is sanitized before it is
// assigned to innerHTML. Inline event handlers and scripts are removed; data-* attributes (used by
// ui_actions.js), classes, ids and inline styles are kept.
function sanitizeHtml(html) {
  return DOMPurify.sanitize(html, { ADD_ATTR: ['target'] });
}

module.exports = { sanitizeHtml };
