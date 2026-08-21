'use strict';

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

function parseLimit(value) {
  return Math.min(Math.max(Number(value) || DEFAULT_LIMIT, 1), MAX_LIMIT);
}

function getLeanWorkItemsPagination(query = {}) {
  const mode = query.pagination == null
    ? 'offset'
    : String(query.pagination).trim().toLowerCase();
  const limit = parseLimit(query.limit);

  if (!['offset', 'keyset'].includes(mode)) {
    return {
      ok: false,
      status: 400,
      error: `Unsupported pagination mode: ${mode}`,
    };
  }

  if (mode === 'offset') {
    return {
      ok: true,
      mode,
      limit,
      offset: Math.max(Number(query.offset) || 0, 0),
      afterWorkItemId: null,
      orderBy: 'changed_date DESC NULLS LAST, work_item_id ASC',
    };
  }

  if (query.offset != null && Number(query.offset) !== 0) {
    return {
      ok: false,
      status: 400,
      error: 'offset cannot be combined with keyset pagination',
    };
  }

  const rawAfter = query.afterWorkItemId == null
    ? 0
    : Number(query.afterWorkItemId);
  if (!Number.isInteger(rawAfter) || rawAfter < 0) {
    return {
      ok: false,
      status: 400,
      error: 'afterWorkItemId must be a non-negative integer',
    };
  }

  return {
    ok: true,
    mode,
    limit,
    offset: null,
    afterWorkItemId: rawAfter,
    orderBy: 'work_item_id ASC',
  };
}

module.exports = {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  getLeanWorkItemsPagination,
};
