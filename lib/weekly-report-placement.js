const CANDIDATE_WORK_ITEMS_SQL = `
  SELECT
    work_item_id AS "workItemId",
    type,
    title,
    state,
    release,
    area_path AS "areaPath",
    feature_id AS "featureId",
    feature,
    weekly_report_remark AS remark,
    weekly_report_remark_revision AS "remarkRevision",
    weekly_report_remark_changed_at AS "remarkChangedAt",
    weekly_report_remark_changed_by AS "remarkChangedBy",
    tags
  FROM tfs_workitems_analytics
  WHERE is_deleted = FALSE
    AND area_path = ANY($1::text[])
  ORDER BY work_item_id
  LIMIT $2
`;

const ACTIVE_PLACEMENT_OVERRIDES_SQL = `
  SELECT
    placement.layout_key AS "layoutKey",
    placement.work_item_id AS "workItemId",
    placement.action,
    placement.tab_key AS "tabKey",
    placement.section_key AS "sectionKey",
    placement.reason,
    placement.created_by AS "createdBy",
    placement.created_at AS "createdAt",
    placement.updated_at AS "updatedAt",
    work_item.work_item_id AS "resolvedWorkItemId",
    work_item.is_deleted AS "workItemDeleted",
    work_item.area_path AS "workItemAreaPath"
  FROM weekly_report_placement_overrides placement
  LEFT JOIN tfs_workitems_analytics work_item
    ON work_item.work_item_id = placement.work_item_id
  WHERE placement.layout_key = $1
    AND placement.is_active = TRUE
  ORDER BY placement.work_item_id
`;

function validationIssue(severity, code, message, options = {}) {
  return {
    severity,
    code,
    path: options.path || null,
    workItemId: options.workItemId || null,
    message,
    ...options.extra,
  };
}

function normalizeComparable(value) {
  return String(value ?? '').trim().toLowerCase();
}

function parseTags(tags) {
  if (tags === null || tags === undefined || String(tags).trim() === '') return [];
  const seen = new Set();
  const values = [];
  for (const tag of String(tags).split(/[;,|\r\n]+/)) {
    const trimmed = tag.trim();
    if (!trimmed) continue;
    const normalized = trimmed.toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    values.push(trimmed);
  }
  return values;
}

function normalizeWorkItem(row) {
  return {
    workItemId: Number(row.workItemId),
    type: String(row.type || ''),
    title: String(row.title || ''),
    state: String(row.state || ''),
    release: row.release === null || row.release === undefined || String(row.release).trim() === ''
      ? null
      : String(row.release).trim(),
    areaPath: row.areaPath === null || row.areaPath === undefined ? null : String(row.areaPath),
    featureId: row.featureId === null || row.featureId === undefined || row.featureId === ''
      ? null
      : Number(row.featureId),
    feature: row.feature === null || row.feature === undefined ? null : String(row.feature),
    remark: row.remark === null || row.remark === undefined ? null : String(row.remark),
    remarkRevision: row.remarkRevision === null || row.remarkRevision === undefined || row.remarkRevision === ''
      ? null
      : Number(row.remarkRevision),
    remarkChangedAt: row.remarkChangedAt ?? null,
    remarkChangedBy: row.remarkChangedBy === null || row.remarkChangedBy === undefined
      ? null
      : String(row.remarkChangedBy),
    tags: row.tags === null || row.tags === undefined ? null : String(row.tags),
    parsedTags: parseTags(row.tags),
  };
}

function evaluateFilters(workItem, filters) {
  const reasons = [];
  const typeSet = new Set((filters.types || []).map(normalizeComparable));
  const excludedStateSet = new Set((filters.excludeStates || []).map(normalizeComparable));
  const requiredTags = (filters.requiredTags || []).map((tag) => ({
    display: tag,
    normalized: normalizeComparable(tag),
  }));
  const actualTags = new Set(workItem.parsedTags.map(normalizeComparable));

  if (!typeSet.has(normalizeComparable(workItem.type))) {
    reasons.push({ code: 'TYPE_NOT_ALLOWED', detail: workItem.type || '(empty)' });
  }
  if (excludedStateSet.has(normalizeComparable(workItem.state))) {
    reasons.push({ code: 'STATE_EXCLUDED', detail: workItem.state || '(empty)' });
  }

  if (requiredTags.length > 0) {
    const matching = requiredTags.filter((tag) => actualTags.has(tag.normalized));
    const passes = filters.requiredTagsMode === 'any'
      ? matching.length > 0
      : matching.length === requiredTags.length;
    if (!passes) {
      const missing = requiredTags
        .filter((tag) => !actualTags.has(tag.normalized))
        .map((tag) => tag.display);
      reasons.push({
        code: 'MISSING_REQUIRED_TAG',
        detail: filters.requiredTagsMode === 'any'
          ? `Requires any of: ${requiredTags.map((tag) => tag.display).join(', ')}`
          : `Missing: ${missing.join(', ')}`,
      });
    }
  }

  return { eligible: reasons.length === 0, reasons };
}

function buildDestinations(layout) {
  const destinations = new Map();
  const tabs = [...layout.tabs]
    .sort((left, right) => left.order - right.order || left.key.localeCompare(right.key))
    .map((tab) => ({
      key: tab.key,
      name: tab.name,
      order: tab.order,
      count: 0,
      sections: [...tab.sections]
        .sort((left, right) => left.order - right.order || left.key.localeCompare(right.key))
        .map((section) => ({
          key: section.key,
          name: section.name,
          order: section.order,
          grouping: section.grouping,
          count: 0,
        })),
    }));

  for (const tab of tabs) {
    for (const section of tab.sections) {
      destinations.set(
        `${normalizeComparable(tab.key)}::${normalizeComparable(section.key)}`,
        { tab, section },
      );
    }
  }
  return { tabs, destinations };
}

function matchesPlacementRule(workItem, rule) {
  const areaPaths = new Set((rule.match.areaPaths || []).map(normalizeComparable));
  return areaPaths.has(normalizeComparable(workItem.areaPath));
}

function resolveWorkItemPlacement({ workItem, layout, override = null, destinations = null, sortedRules = null }) {
  const item = workItem?.parsedTags ? workItem : normalizeWorkItem(workItem || {});
  const filterResult = evaluateFilters(item, layout.filters);
  const sourcePaths = new Set((layout.source?.areaPaths || []).map(normalizeComparable));
  const sourceMatch = sourcePaths.has(normalizeComparable(item.areaPath));
  const resolvedDestinations = destinations || buildDestinations(layout).destinations;
  const resolvedRules = sortedRules || [...layout.placementRules]
    .sort((left, right) => left.priority - right.priority || left.key.localeCompare(right.key));
  const base = {
    item,
    sourceMatch,
    filterResult,
    overrideAction: override?.action || null,
    effectiveEligible: false,
    exclusionReasons: [],
    placementSource: null,
    placementKey: null,
    destination: null,
    target: null,
    matchingRuleKeys: [],
  };

  if (!sourceMatch) {
    return {
      ...base,
      exclusionReasons: ['AREA_PATH_OUTSIDE_SOURCE'],
    };
  }

  if (override?.action === 'exclude') {
    return {
      ...base,
      exclusionReasons: ['OVERRIDE_EXCLUDED'],
    };
  }

  let placementSource = null;
  let placementKey = null;
  let destination = null;
  let matchingRuleKeys = [];
  if (override?.action === 'place') {
    placementSource = 'override';
    placementKey = `${normalizeComparable(override.tabKey)}::${normalizeComparable(override.sectionKey)}`;
    destination = resolvedDestinations.get(placementKey) || null;
  } else if (!filterResult.eligible) {
    return {
      ...base,
      exclusionReasons: filterResult.reasons.map((reason) => reason.code),
    };
  } else {
    const matches = resolvedRules.filter((rule) => matchesPlacementRule(item, rule));
    matchingRuleKeys = matches.map((rule) => rule.key);
    if (matches.length > 0) {
      placementSource = 'rule';
      placementKey = matches[0].key;
      destination = resolvedDestinations.get(
        `${normalizeComparable(matches[0].target.tabKey)}::${normalizeComparable(matches[0].target.sectionKey)}`,
      ) || null;
    }
  }

  return {
    ...base,
    effectiveEligible: true,
    placementSource,
    placementKey,
    destination,
    target: destination
      ? { tabKey: destination.tab.key, sectionKey: destination.section.key }
      : null,
    matchingRuleKeys,
  };
}

function incrementReason(counts, code) {
  counts[code] = (counts[code] || 0) + 1;
}

function validateRuntimeConfigurationValues(items, layout, warnings) {
  const actualTypes = new Set(items.map((item) => normalizeComparable(item.type)));
  const actualStates = new Set(items.map((item) => normalizeComparable(item.state)));
  const actualTags = new Set(items.flatMap((item) => item.parsedTags.map(normalizeComparable)));

  for (const type of layout.filters.types) {
    if (!actualTypes.has(normalizeComparable(type))) {
      warnings.push(validationIssue('warning', 'CONFIGURED_TYPE_NOT_FOUND', `Configured type '${type}' was not found in source data.`, {
        path: 'filters.types',
      }));
    }
  }
  for (const state of layout.filters.excludeStates) {
    if (!actualStates.has(normalizeComparable(state))) {
      warnings.push(validationIssue('warning', 'CONFIGURED_STATE_NOT_FOUND', `Configured excluded state '${state}' was not found in source data.`, {
        path: 'filters.excludeStates',
      }));
    }
  }
  for (const tag of layout.filters.requiredTags) {
    if (!actualTags.has(normalizeComparable(tag))) {
      warnings.push(validationIssue('warning', 'CONFIGURED_TAG_NOT_FOUND', `Required tag '${tag}' was not found in source data.`, {
        path: 'filters.requiredTags',
      }));
    }
  }
}

function validateOverridePopulation(overrides, itemMap, layout, destinations, warnings, errors, candidateOverflow) {
  const sourcePaths = new Set(layout.source.areaPaths.map(normalizeComparable));
  for (const override of overrides) {
    const workItemId = Number(override.workItemId);
    if (override.action === 'place') {
      const destinationKey = `${normalizeComparable(override.tabKey)}::${normalizeComparable(override.sectionKey)}`;
      if (!destinations.has(destinationKey)) {
        errors.push(validationIssue('error', 'INVALID_OVERRIDE_TARGET', `Override target '${override.tabKey}/${override.sectionKey}' does not exist in the layout.`, {
          workItemId,
          path: 'weekly_report_placement_overrides',
        }));
      }
    }

    if (itemMap.has(workItemId)) continue;
    if (override.resolvedWorkItemId === null || override.resolvedWorkItemId === undefined) {
      warnings.push(validationIssue('warning', 'STALE_OVERRIDE_WORK_ITEM_MISSING', 'Placement override references a work item that is not present in analytics data.', {
        workItemId,
        path: 'weekly_report_placement_overrides',
      }));
    } else if (override.workItemDeleted === true) {
      warnings.push(validationIssue('warning', 'STALE_OVERRIDE_WORK_ITEM_DELETED', 'Placement override references a soft-deleted work item.', {
        workItemId,
        path: 'weekly_report_placement_overrides',
      }));
    } else if (!sourcePaths.has(normalizeComparable(override.workItemAreaPath))) {
      warnings.push(validationIssue('warning', 'OVERRIDE_OUTSIDE_SOURCE', `Placement override references area path '${override.workItemAreaPath}', which is outside the layout source.`, {
        workItemId,
        path: 'weekly_report_placement_overrides',
      }));
    } else if (candidateOverflow) {
      warnings.push(validationIssue('warning', 'OVERRIDE_NOT_EVALUATED', 'Placement override could not be evaluated because the candidate result exceeded its limit.', {
        workItemId,
        path: 'weekly_report_placement_overrides',
      }));
    }
  }
}

async function fetchPlacementInputs(pool, layoutKey, layout) {
  const candidateLimit = layout.limits.candidateRows;
  const [candidateResult, overrideResult] = await Promise.all([
    pool.query(CANDIDATE_WORK_ITEMS_SQL, [layout.source.areaPaths, candidateLimit + 1]),
    pool.query(ACTIVE_PLACEMENT_OVERRIDES_SQL, [layoutKey]),
  ]);
  const candidateOverflow = candidateResult.rows.length > candidateLimit;
  return {
    candidates: candidateResult.rows.slice(0, candidateLimit),
    candidateOverflow,
    candidateCountLowerBound: candidateResult.rows.length,
    overrides: overrideResult.rows,
  };
}

function resolvePlacementPreview({ layoutKey, layout, candidates, overrides = [], candidateOverflow = false, candidateCountLowerBound = null }) {
  const warnings = [];
  const errors = [];
  const uniqueItems = new Map();
  for (const row of candidates || []) {
    const item = normalizeWorkItem(row);
    if (!Number.isInteger(item.workItemId) || item.workItemId <= 0) continue;
    if (!uniqueItems.has(item.workItemId)) uniqueItems.set(item.workItemId, item);
  }
  const items = [...uniqueItems.values()].sort((left, right) => left.workItemId - right.workItemId);
  const { tabs, destinations } = buildDestinations(layout);
  const overrideMap = new Map((overrides || []).map((entry) => [Number(entry.workItemId), entry]));

  if (candidateOverflow) {
    errors.push(validationIssue('error', 'CANDIDATE_ROW_LIMIT_EXCEEDED', `The source contains more than ${layout.limits.candidateRows} candidate records.`, {
      path: 'limits.candidateRows',
    }));
  }

  validateRuntimeConfigurationValues(items, layout, warnings);
  validateOverridePopulation(overrides, uniqueItems, layout, destinations, warnings, errors, candidateOverflow);

  const sortedRules = [...layout.placementRules]
    .sort((left, right) => left.priority - right.priority || left.key.localeCompare(right.key));
  const placements = [];
  const excludedExamples = [];
  const exclusionCounts = {};
  const featureIds = new Set(items.filter((item) => item.type === 'Feature').map((item) => item.workItemId));
  const synthesizedFeatures = new Set();
  let eligibleByRules = 0;
  let forcedIncluded = 0;
  let forcedExcluded = 0;
  let excludedCount = 0;
  let unplacedCount = 0;

  for (const item of items) {
    const override = overrideMap.get(item.workItemId);
    const resolution = resolveWorkItemPlacement({
      workItem: item,
      layout,
      override,
      destinations,
      sortedRules,
    });
    const { filterResult } = resolution;
    if (filterResult.eligible) eligibleByRules += 1;

    if (override?.action === 'exclude') {
      forcedExcluded += 1;
      excludedCount += 1;
      incrementReason(exclusionCounts, 'OVERRIDE_EXCLUDED');
      if (excludedExamples.length < 50) excludedExamples.push({ workItemId: item.workItemId, reasons: ['OVERRIDE_EXCLUDED'] });
      continue;
    }

    const destination = resolution.destination;
    const placementSource = resolution.placementSource;
    const placementKey = resolution.placementKey;
    if (override?.action === 'place') {
      if (!filterResult.eligible) {
        forcedIncluded += 1;
        warnings.push(validationIssue('warning', 'FORCED_INCLUDE_FILTER_MISMATCH', `Placement override force-includes an item that fails: ${filterResult.reasons.map((reason) => reason.code).join(', ')}.`, {
          workItemId: item.workItemId,
          path: 'weekly_report_placement_overrides',
        }));
      }
    } else if (!resolution.effectiveEligible) {
      excludedCount += 1;
      for (const reason of filterResult.reasons) incrementReason(exclusionCounts, reason.code);
      if (excludedExamples.length < 50) {
        excludedExamples.push({
          workItemId: item.workItemId,
          reasons: filterResult.reasons.map((reason) => reason.code),
        });
      }
      continue;
    } else if (resolution.matchingRuleKeys.length > 1) {
      warnings.push(validationIssue('warning', 'MULTIPLE_RULE_MATCHES', `Multiple placement rules match; '${resolution.matchingRuleKeys[0]}' wins by priority.`, {
        workItemId: item.workItemId,
        path: 'placementRules',
      }));
    }

    if (!destination) {
      unplacedCount += 1;
      errors.push(validationIssue('error', 'ELIGIBLE_ITEM_UNPLACED', 'Eligible item does not resolve to a valid tab and section.', {
        workItemId: item.workItemId,
        path: placementSource === 'override' ? 'weekly_report_placement_overrides' : 'placementRules',
      }));
      continue;
    }

    destination.tab.count += 1;
    destination.section.count += 1;
    placements.push({
      workItemId: item.workItemId,
      type: item.type,
      title: item.title,
      state: item.state,
      release: item.release,
      areaPath: item.areaPath,
      featureId: item.featureId,
      feature: item.feature,
      remark: item.remark,
      remarkRevision: item.remarkRevision,
      remarkChangedAt: item.remarkChangedAt,
      remarkChangedBy: item.remarkChangedBy,
      tags: item.parsedTags,
      placementSource,
      placementKey,
      target: {
        tabKey: destination.tab.key,
        sectionKey: destination.section.key,
      },
      filterMismatches: filterResult.reasons.map((reason) => reason.code),
    });

    if (Number.isInteger(item.featureId) && item.featureId > 0 && !featureIds.has(item.featureId) && !synthesizedFeatures.has(item.featureId)) {
      synthesizedFeatures.add(item.featureId);
      warnings.push(validationIssue('warning', 'SYNTHESIZED_FEATURE_HEADER', `Feature ${item.featureId} is not included as a source record; its header will be synthesized from child metadata.`, {
        workItemId: item.featureId,
        path: 'grouping',
      }));
    }
  }

  placements.sort((left, right) => {
    const leftDestination = destinations.get(`${normalizeComparable(left.target.tabKey)}::${normalizeComparable(left.target.sectionKey)}`);
    const rightDestination = destinations.get(`${normalizeComparable(right.target.tabKey)}::${normalizeComparable(right.target.sectionKey)}`);
    return leftDestination.tab.order - rightDestination.tab.order ||
      leftDestination.section.order - rightDestination.section.order ||
      left.workItemId - right.workItemId;
  });

  if (placements.length === 0) {
    errors.push(validationIssue('error', 'ZERO_PLACED_ITEMS', 'No records are eligible and placed for this layout.'));
  }
  const placementsTruncated = placements.length > layout.limits.includedRows;
  if (placementsTruncated) {
    errors.push(validationIssue('error', 'INCLUDED_ROW_LIMIT_EXCEEDED', `The placement result contains ${placements.length} records, exceeding the limit of ${layout.limits.includedRows}.`, {
      path: 'limits.includedRows',
    }));
  }

  return {
    layout: layoutKey,
    summary: {
      candidateCount: candidateOverflow
        ? Math.max(candidateCountLowerBound || 0, items.length + 1)
        : items.length,
      candidateCountIsLowerBound: candidateOverflow,
      eligibleByRules,
      forcedIncluded,
      forcedExcluded,
      placedCount: placements.length,
      unplacedCount,
      excludedCount,
    },
    tabs,
    placements: placements.slice(0, layout.limits.includedRows),
    placementsTruncated,
    exclusionCounts,
    excludedExamples,
    validation: {
      validForExport: errors.length === 0,
      errors,
      warnings,
    },
  };
}

module.exports = {
  CANDIDATE_WORK_ITEMS_SQL,
  ACTIVE_PLACEMENT_OVERRIDES_SQL,
  parseTags,
  normalizeComparable,
  normalizeWorkItem,
  evaluateFilters,
  buildDestinations,
  matchesPlacementRule,
  resolveWorkItemPlacement,
  fetchPlacementInputs,
  resolvePlacementPreview,
};
