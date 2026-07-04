function encodeCursor(offset) {
  return Buffer.from(JSON.stringify({ offset }), 'utf8').toString('base64url');
}

function decodeCursor(cursor) {
  if (!cursor) {
    return 0;
  }

  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    return Number.isInteger(parsed.offset) && parsed.offset >= 0 ? parsed.offset : 0;
  } catch {
    return 0;
  }
}

function normalizeLimit(limit, defaults = {}) {
  const defaultLimit = defaults.defaultLimit || 50;
  const maxLimit = defaults.maxLimit || 200;
  // limit === 0 means "all" (uncapped). Intended for bounded sets like a
  // class's members; use with care on large symbol searches.
  if (limit === 0) {
    return Infinity;
  }
  const requested = Number.isInteger(limit) && limit > 0 ? limit : defaultLimit;
  return Math.min(requested, maxLimit);
}

function paginate(items, options = {}, defaults = {}) {
  const offset = decodeCursor(options.cursor);
  const limit = normalizeLimit(options.limit, defaults);
  const pageItems = Number.isFinite(limit) ? items.slice(offset, offset + limit) : items.slice(offset);
  const nextOffset = offset + pageItems.length;

  return {
    items: pageItems,
    page: {
      cursor: options.cursor || null,
      nextCursor: nextOffset < items.length ? encodeCursor(nextOffset) : null,
      limit: Number.isFinite(limit) ? limit : pageItems.length,
      totalApprox: items.length
    }
  };
}

module.exports = {
  decodeCursor,
  encodeCursor,
  normalizeLimit,
  paginate
};
