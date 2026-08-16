const fs = require('fs');

const CONFIG_SCHEMA_VERSION = 2;
const MAX_CANDIDATE_ROWS = 10000;
const MAX_INCLUDED_ROWS = 2000;
const REQUIRED_COLUMN_KEYS = [
  'version',
  'workItemId',
  'type',
  'title',
  'state',
  'remark',
];

function issue(severity, code, path, message, extra = {}) {
  return { severity, code, path, message, ...extra };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validateKnownKeys(value, allowed, path, issues) {
  if (!isPlainObject(value)) return;
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      issues.push(issue('error', 'UNKNOWN_PROPERTY', `${path}.${key}`, `Unsupported property '${key}'.`));
    }
  }
}

function validateNonEmptyString(value, path, issues) {
  if (typeof value !== 'string' || value.trim() === '') {
    issues.push(issue('error', 'REQUIRED_STRING', path, 'A non-empty string is required.'));
    return false;
  }
  return true;
}

function validateStringArray(value, path, issues, options = {}) {
  if (!Array.isArray(value) || (options.nonEmpty && value.length === 0)) {
    issues.push(issue('error', 'INVALID_STRING_ARRAY', path, options.nonEmpty
      ? 'A non-empty array of strings is required.'
      : 'An array of strings is required.'));
    return [];
  }
  const seen = new Set();
  const valid = [];
  value.forEach((entry, index) => {
    if (typeof entry !== 'string' || entry.trim() === '') {
      issues.push(issue('error', 'INVALID_STRING_ARRAY_ITEM', `${path}[${index}]`, 'A non-empty string is required.'));
      return;
    }
    const normalized = entry.trim().toLowerCase();
    if (seen.has(normalized)) {
      issues.push(issue('error', 'DUPLICATE_VALUE', `${path}[${index}]`, `Duplicate value '${entry}'.`));
      return;
    }
    seen.add(normalized);
    valid.push(entry.trim());
  });
  return valid;
}

function validateWorksheetName(name, path, issues) {
  if (
    !validateNonEmptyString(name, path, issues) ||
    name.length > 31 ||
    /[\\/\?\*\[\]:]/.test(name)
  ) {
    if (typeof name === 'string' && name.trim() !== '') {
      issues.push(issue('error', 'INVALID_WORKSHEET_NAME', path, 'Excel worksheet names must be 31 characters or fewer and cannot contain \\ / ? * [ ] :.'));
    }
  }
}

function validateOrder(value, path, issues) {
  if (!Number.isInteger(value) || value < 0) {
    issues.push(issue('error', 'INVALID_ORDER', path, 'A non-negative integer is required.'));
  }
}

function validateLayout(layoutKey, layout) {
  const issues = [];
  const root = `layouts.${layoutKey}`;
  if (!isPlainObject(layout)) {
    return [issue('error', 'INVALID_LAYOUT', root, 'Layout must be an object.')];
  }

  validateKnownKeys(layout, ['description', 'source', 'filters', 'limits', 'tabs', 'placementRules', 'columns'], root, issues);

  const source = layout.source;
  if (!isPlainObject(source)) {
    issues.push(issue('error', 'INVALID_SOURCE', `${root}.source`, 'Source must be an object.'));
  } else {
    validateKnownKeys(source, ['areaPaths', 'match'], `${root}.source`, issues);
    validateStringArray(source.areaPaths, `${root}.source.areaPaths`, issues, { nonEmpty: true });
    if (source.match !== 'exact') {
      issues.push(issue('error', 'UNSUPPORTED_AREA_MATCH', `${root}.source.match`, 'Only exact area-path matching is supported.'));
    }
  }

  const filters = layout.filters;
  if (!isPlainObject(filters)) {
    issues.push(issue('error', 'INVALID_FILTERS', `${root}.filters`, 'Filters must be an object.'));
  } else {
    validateKnownKeys(filters, ['types', 'excludeStates', 'requiredTags', 'requiredTagsMode'], `${root}.filters`, issues);
    validateStringArray(filters.types, `${root}.filters.types`, issues, { nonEmpty: true });
    validateStringArray(filters.excludeStates, `${root}.filters.excludeStates`, issues);
    validateStringArray(filters.requiredTags, `${root}.filters.requiredTags`, issues);
    if (!['all', 'any'].includes(filters.requiredTagsMode)) {
      issues.push(issue('error', 'INVALID_REQUIRED_TAGS_MODE', `${root}.filters.requiredTagsMode`, 'requiredTagsMode must be "all" or "any".'));
    }
  }

  const limits = layout.limits;
  if (!isPlainObject(limits)) {
    issues.push(issue('error', 'INVALID_LIMITS', `${root}.limits`, 'Limits must be an object.'));
  } else {
    validateKnownKeys(limits, ['candidateRows', 'includedRows'], `${root}.limits`, issues);
    if (!Number.isInteger(limits.candidateRows) || limits.candidateRows < 1 || limits.candidateRows > MAX_CANDIDATE_ROWS) {
      issues.push(issue('error', 'INVALID_CANDIDATE_LIMIT', `${root}.limits.candidateRows`, `candidateRows must be between 1 and ${MAX_CANDIDATE_ROWS}.`));
    }
    if (!Number.isInteger(limits.includedRows) || limits.includedRows < 1 || limits.includedRows > MAX_INCLUDED_ROWS) {
      issues.push(issue('error', 'INVALID_INCLUDED_LIMIT', `${root}.limits.includedRows`, `includedRows must be between 1 and ${MAX_INCLUDED_ROWS}.`));
    }
  }

  const tabKeys = new Set();
  const tabNames = new Set();
  const destinationKeys = new Set();
  const tabOrders = new Set();
  if (!Array.isArray(layout.tabs) || layout.tabs.length === 0) {
    issues.push(issue('error', 'INVALID_TABS', `${root}.tabs`, 'At least one tab is required.'));
  } else {
    layout.tabs.forEach((tab, tabIndex) => {
      const tabPath = `${root}.tabs[${tabIndex}]`;
      if (!isPlainObject(tab)) {
        issues.push(issue('error', 'INVALID_TAB', tabPath, 'Tab must be an object.'));
        return;
      }
      validateKnownKeys(tab, ['key', 'name', 'order', 'sections'], tabPath, issues);
      if (validateNonEmptyString(tab.key, `${tabPath}.key`, issues)) {
        const normalizedKey = tab.key.trim().toLowerCase();
        if (tabKeys.has(normalizedKey)) issues.push(issue('error', 'DUPLICATE_TAB_KEY', `${tabPath}.key`, `Duplicate tab key '${tab.key}'.`));
        tabKeys.add(normalizedKey);
      }
      validateWorksheetName(tab.name, `${tabPath}.name`, issues);
      if (typeof tab.name === 'string') {
        const normalizedName = tab.name.trim().toLowerCase();
        if (tabNames.has(normalizedName)) issues.push(issue('error', 'DUPLICATE_TAB_NAME', `${tabPath}.name`, `Duplicate worksheet name '${tab.name}'.`));
        tabNames.add(normalizedName);
      }
      validateOrder(tab.order, `${tabPath}.order`, issues);
      if (Number.isInteger(tab.order) && tabOrders.has(tab.order)) issues.push(issue('error', 'DUPLICATE_TAB_ORDER', `${tabPath}.order`, `Duplicate tab order '${tab.order}'.`));
      tabOrders.add(tab.order);

      const sectionKeys = new Set();
      const sectionOrders = new Set();
      if (!Array.isArray(tab.sections) || tab.sections.length === 0) {
        issues.push(issue('error', 'INVALID_SECTIONS', `${tabPath}.sections`, 'At least one section is required.'));
        return;
      }
      tab.sections.forEach((section, sectionIndex) => {
        const sectionPath = `${tabPath}.sections[${sectionIndex}]`;
        if (!isPlainObject(section)) {
          issues.push(issue('error', 'INVALID_SECTION', sectionPath, 'Section must be an object.'));
          return;
        }
        validateKnownKeys(section, ['key', 'name', 'order', 'grouping'], sectionPath, issues);
        if (validateNonEmptyString(section.key, `${sectionPath}.key`, issues)) {
          const normalizedKey = section.key.trim().toLowerCase();
          if (sectionKeys.has(normalizedKey)) issues.push(issue('error', 'DUPLICATE_SECTION_KEY', `${sectionPath}.key`, `Duplicate section key '${section.key}'.`));
          sectionKeys.add(normalizedKey);
          if (typeof tab.key === 'string') destinationKeys.add(`${tab.key.trim().toLowerCase()}::${normalizedKey}`);
        }
        validateNonEmptyString(section.name, `${sectionPath}.name`, issues);
        validateOrder(section.order, `${sectionPath}.order`, issues);
        if (Number.isInteger(section.order) && sectionOrders.has(section.order)) issues.push(issue('error', 'DUPLICATE_SECTION_ORDER', `${sectionPath}.order`, `Duplicate section order '${section.order}'.`));
        sectionOrders.add(section.order);

        const grouping = section.grouping;
        if (!isPlainObject(grouping)) {
          issues.push(issue('error', 'INVALID_GROUPING', `${sectionPath}.grouping`, 'Grouping must be an object.'));
        } else {
          validateKnownKeys(grouping, ['levels', 'includeStandaloneItems'], `${sectionPath}.grouping`, issues);
          if (JSON.stringify(grouping.levels) !== JSON.stringify(['release', 'feature'])) {
            issues.push(issue('error', 'UNSUPPORTED_GROUPING', `${sectionPath}.grouping.levels`, 'Only ["release", "feature"] grouping is supported.'));
          }
          if (grouping.includeStandaloneItems !== true) {
            issues.push(issue('error', 'INVALID_STANDALONE_SETTING', `${sectionPath}.grouping.includeStandaloneItems`, 'includeStandaloneItems must be true.'));
          }
        }
      });
    });
  }

  const sourcePaths = new Set(
    (Array.isArray(source?.areaPaths) ? source.areaPaths : [])
      .map((value) => String(value).trim().toLowerCase()),
  );
  const ruleKeys = new Set();
  const priorities = new Set();
  if (!Array.isArray(layout.placementRules) || layout.placementRules.length === 0) {
    issues.push(issue('error', 'INVALID_PLACEMENT_RULES', `${root}.placementRules`, 'At least one placement rule is required.'));
  } else {
    layout.placementRules.forEach((rule, index) => {
      const rulePath = `${root}.placementRules[${index}]`;
      if (!isPlainObject(rule)) {
        issues.push(issue('error', 'INVALID_PLACEMENT_RULE', rulePath, 'Placement rule must be an object.'));
        return;
      }
      validateKnownKeys(rule, ['key', 'priority', 'match', 'target'], rulePath, issues);
      if (validateNonEmptyString(rule.key, `${rulePath}.key`, issues)) {
        const normalizedKey = rule.key.trim().toLowerCase();
        if (ruleKeys.has(normalizedKey)) issues.push(issue('error', 'DUPLICATE_RULE_KEY', `${rulePath}.key`, `Duplicate placement rule key '${rule.key}'.`));
        ruleKeys.add(normalizedKey);
      }
      validateOrder(rule.priority, `${rulePath}.priority`, issues);
      if (Number.isInteger(rule.priority) && priorities.has(rule.priority)) issues.push(issue('error', 'DUPLICATE_RULE_PRIORITY', `${rulePath}.priority`, `Duplicate placement rule priority '${rule.priority}'.`));
      priorities.add(rule.priority);

      if (!isPlainObject(rule.match)) {
        issues.push(issue('error', 'INVALID_RULE_MATCH', `${rulePath}.match`, 'Rule match must be an object.'));
      } else {
        validateKnownKeys(rule.match, ['areaPaths'], `${rulePath}.match`, issues);
        const rulePaths = validateStringArray(rule.match.areaPaths, `${rulePath}.match.areaPaths`, issues, { nonEmpty: true });
        rulePaths.forEach((areaPath) => {
          if (!sourcePaths.has(areaPath.toLowerCase())) {
            issues.push(issue('error', 'RULE_AREA_OUTSIDE_SOURCE', `${rulePath}.match.areaPaths`, `Area path '${areaPath}' is not declared by the layout source.`));
          }
        });
      }

      if (!isPlainObject(rule.target)) {
        issues.push(issue('error', 'INVALID_RULE_TARGET', `${rulePath}.target`, 'Rule target must be an object.'));
      } else {
        validateKnownKeys(rule.target, ['tabKey', 'sectionKey'], `${rulePath}.target`, issues);
        validateNonEmptyString(rule.target.tabKey, `${rulePath}.target.tabKey`, issues);
        validateNonEmptyString(rule.target.sectionKey, `${rulePath}.target.sectionKey`, issues);
        const destination = `${String(rule.target.tabKey || '').trim().toLowerCase()}::${String(rule.target.sectionKey || '').trim().toLowerCase()}`;
        if (!destinationKeys.has(destination)) {
          issues.push(issue('error', 'INVALID_SECTION_REFERENCE', `${rulePath}.target`, `Target '${rule.target.tabKey}/${rule.target.sectionKey}' does not reference a configured tab and section.`));
        }
      }
    });
  }

  if (!Array.isArray(layout.columns) || layout.columns.length !== REQUIRED_COLUMN_KEYS.length) {
    issues.push(issue('error', 'INVALID_COLUMNS', `${root}.columns`, `Exactly ${REQUIRED_COLUMN_KEYS.length} columns are required.`));
  } else {
    const keys = layout.columns.map((column) => column?.key);
    if (JSON.stringify(keys) !== JSON.stringify(REQUIRED_COLUMN_KEYS)) {
      issues.push(issue('error', 'INVALID_COLUMN_ORDER', `${root}.columns`, `Columns must use this order: ${REQUIRED_COLUMN_KEYS.join(', ')}.`));
    }
    layout.columns.forEach((column, index) => {
      const columnPath = `${root}.columns[${index}]`;
      if (!isPlainObject(column)) {
        issues.push(issue('error', 'INVALID_COLUMN', columnPath, 'Column must be an object.'));
        return;
      }
      validateKnownKeys(column, ['key', 'header', 'width'], columnPath, issues);
      validateNonEmptyString(column.header, `${columnPath}.header`, issues);
      if (!Number.isFinite(column.width) || column.width < 1 || column.width > 255) {
        issues.push(issue('error', 'INVALID_COLUMN_WIDTH', `${columnPath}.width`, 'Column width must be between 1 and 255.'));
      }
    });
  }

  return issues;
}

function validateWeeklyReportDefinition(config) {
  const issues = [];
  if (!isPlainObject(config)) {
    const errors = [issue('error', 'INVALID_CONFIGURATION', '$', 'Configuration must be an object.')];
    return { ok: false, validForExport: false, errors, warnings: [], issues: errors };
  }
  validateKnownKeys(config, ['schemaVersion', 'layouts'], '$', issues);
  if (config.schemaVersion !== CONFIG_SCHEMA_VERSION) {
    issues.push(issue('error', 'INVALID_SCHEMA_VERSION', '$.schemaVersion', `schemaVersion must be ${CONFIG_SCHEMA_VERSION}.`));
  }
  if (!isPlainObject(config.layouts) || Object.keys(config.layouts).length === 0) {
    issues.push(issue('error', 'INVALID_LAYOUTS', '$.layouts', 'At least one layout is required.'));
  } else {
    for (const [layoutKey, layout] of Object.entries(config.layouts)) {
      if (!String(layoutKey).trim()) {
        issues.push(issue('error', 'INVALID_LAYOUT_KEY', '$.layouts', 'Layout keys cannot be empty.'));
        continue;
      }
      issues.push(...validateLayout(layoutKey, layout));
    }
  }
  const errors = issues.filter((entry) => entry.severity === 'error');
  const warnings = issues.filter((entry) => entry.severity === 'warning');
  return { ok: errors.length === 0, validForExport: errors.length === 0, errors, warnings, issues };
}

function loadWeeklyReportDefinition(configPath) {
  const raw = fs.readFileSync(configPath, 'utf8');
  const config = JSON.parse(raw);
  return { config, validation: validateWeeklyReportDefinition(config) };
}

function getLayoutDefinition(config, layoutKey) {
  if (!config || !isPlainObject(config.layouts) || !layoutKey) return null;
  return config.layouts[layoutKey] || null;
}

function getLayoutValidation(validation, layoutKey) {
  const layoutPrefix = `layouts.${layoutKey}`;
  const issues = (validation?.issues || []).filter((entry) => (
    entry.path === '$' ||
    entry.path.startsWith('$.') ||
    entry.path === layoutPrefix ||
    entry.path.startsWith(`${layoutPrefix}.`)
  ));
  const errors = issues.filter((entry) => entry.severity === 'error');
  const warnings = issues.filter((entry) => entry.severity === 'warning');
  return {
    ok: errors.length === 0,
    validForExport: errors.length === 0,
    errors,
    warnings,
    issues,
  };
}

module.exports = {
  CONFIG_SCHEMA_VERSION,
  MAX_CANDIDATE_ROWS,
  MAX_INCLUDED_ROWS,
  REQUIRED_COLUMN_KEYS,
  validateWeeklyReportDefinition,
  loadWeeklyReportDefinition,
  getLayoutDefinition,
  getLayoutValidation,
};
