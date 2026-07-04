function escapeRegExp(value) {
  return String(value).replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

function globToRegExp(pattern) {
  const source = String(pattern)
    .split('*')
    .map(escapeRegExp)
    .join('.*');
  return new RegExp(`^${source}$`, 'i');
}

function splitOrTerms(query) {
  const value = String(query || '*').trim();
  if (!value || value === '*') {
    return ['*'];
  }
  return value
    .split('|')
    .map((term) => term.trim())
    .filter(Boolean);
}

function matchesQuery(value, query, options = {}) {
  const text = String(value || '');
  const terms = splitOrTerms(query);
  if (terms.includes('*')) {
    return true;
  }

  return terms.some((term) => {
    if (options.regex) {
      try {
        return new RegExp(term, 'i').test(text);
      } catch {
        // Invalid regex: degrade to a literal substring match instead of crashing.
        return text.toLowerCase().includes(term.toLowerCase());
      }
    }

    if (term.includes('*')) {
      return globToRegExp(term).test(text);
    }

    return text.toLowerCase().includes(term.toLowerCase());
  });
}

function parseFieldFilters(query) {
  const filters = {};
  const parts = String(query || '').split(/\s+/).filter(Boolean);
  const freeText = [];

  for (const part of parts) {
    const match = part.match(/^([a-zA-Z][\w-]*):(.+)$/);
    if (match) {
      filters[match[1]] = match[2];
    } else {
      freeText.push(part);
    }
  }

  return {
    filters,
    query: freeText.join(' ') || '*'
  };
}

module.exports = {
  matchesQuery,
  parseFieldFilters,
  splitOrTerms
};
