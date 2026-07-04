const fs = require('fs');
const path = require('path');

const { EventBus } = require('./eventBus');
const { matchesQuery, parseFieldFilters } = require('./query');
const { paginate } = require('./paging');

const DUMP_FILES = {
  classes: 'ClassesInfo.json',
  structs: 'StructsInfo.json',
  functions: 'FunctionsInfo.json',
  enums: 'EnumsInfo.json',
  offsets: 'OffsetsInfo.json'
};

class DumpspaceSession {
  constructor(options = {}) {
    this.defaultLimit = options.defaultLimit || 50;
    this.maxLimit = options.maxLimit || 200;
    this.eventBus = options.eventBus || new EventBus();
    this.data = {
      classes: {},
      structs: {},
      functions: {},
      enums: {},
      offsets: {}
    };
    this.symbols = [];
    this.symbolById = new Map();
    this.classLikeByName = new Map();
    this.classLikeByLowerName = new Map();
    this.childrenByName = new Map();
    this.symbolByName = new Map();
    this.functionNamesByOwner = new Map();
    this.folderPath = null;
  }

  loadFolder(folderPath) {
    const data = {};
    const missingFiles = [];

    for (const [key, filename] of Object.entries(DUMP_FILES)) {
      const filePath = path.join(folderPath, filename);
      if (!fs.existsSync(filePath)) {
        data[key] = {};
        missingFiles.push(filename);
        continue;
      }

      data[key] = normalizeDumpJson(JSON.parse(fs.readFileSync(filePath, 'utf8')));
    }

    this.folderPath = folderPath;
    this.loadData(data);

    return {
      success: missingFiles.length === 0,
      folderPath,
      missingFiles,
      counts: this.getCounts()
    };
  }

  loadData(data) {
    this.data = {
      classes: data.classes || {},
      structs: data.structs || {},
      functions: data.functions || {},
      enums: data.enums || {},
      offsets: data.offsets || {}
    };
    this.rebuildIndexes();
    this.eventBus.emit('dump:loaded', { counts: this.getCounts(), folderPath: this.folderPath });
  }

  getCounts() {
    return {
      classes: Object.keys(this.data.classes).length,
      structs: Object.keys(this.data.structs).length,
      functions: this.getFunctionEntries().length,
      enums: Object.keys(this.data.enums).length,
      offsets: Object.keys(this.data.offsets).length
    };
  }

  rebuildIndexes() {
    this.symbols = [];
    this.symbolById = new Map();
    this.classLikeByName = new Map();
    this.classLikeByLowerName = new Map();
    this.childrenByName = new Map();
    this.functionNamesByOwner = new Map();

    this.addClassLikeSymbols('class', this.data.classes);
    this.addClassLikeSymbols('struct', this.data.structs);
    this.addSimpleSymbols('enum', this.data.enums);
    this.addSimpleSymbols('offset', this.data.offsets);

    for (const fn of this.getFunctionEntries()) {
      const info = extractFunction(fn.raw);
      this.addSymbol({
        id: `function:${fn.owner || 'global'}::${fn.name}`,
        kind: 'function',
        name: fn.name,
        owner: fn.owner,
        summary: formatFunctionSignature(fn.name, info),
        raw: fn.raw
      });
      if (fn.owner) {
        if (!this.functionNamesByOwner.has(fn.owner)) {
          this.functionNamesByOwner.set(fn.owner, []);
        }
        this.functionNamesByOwner.get(fn.owner).push(fn.name);
      }
    }

    for (const symbol of this.symbols) {
      if ((symbol.kind === 'class' || symbol.kind === 'struct') && symbol.parent) {
        if (!this.childrenByName.has(symbol.parent)) {
          this.childrenByName.set(symbol.parent, []);
        }
        this.childrenByName.get(symbol.parent).push(symbol.name);
      }
    }

    this.symbols.sort((a, b) => a.name.localeCompare(b.name) || a.kind.localeCompare(b.kind));

    // Name -> symbol lookup for resolving detail by bare name across all kinds.
    // Class/struct win ties (they sort before enum/function/offset), so a name
    // shared by e.g. a class and an enum resolves to the class-like symbol.
    this.symbolByName = new Map();
    for (const symbol of this.symbols) {
      if (!this.symbolByName.has(symbol.name)) {
        this.symbolByName.set(symbol.name, symbol);
      }
    }
  }

  addClassLikeSymbols(kind, source) {
    for (const [name, raw] of Object.entries(source || {})) {
      const members = extractMembers(raw);
      const parent = extractParent(raw);
      const size = extractClassSize(raw);
      const sizePart = size != null ? `, size ${formatOffset(size)}` : '';
      const symbol = {
        id: `${kind}:${name}`,
        kind,
        name,
        parent,
        summary: `${members.length} members${parent ? `, extends ${parent}` : ''}${sizePart}`,
        raw
      };
      this.classLikeByName.set(name, symbol);
      this.classLikeByLowerName.set(name.toLowerCase(), symbol);
      this.addSymbol(symbol);
    }
  }

  // Resolve a class/struct by name, tolerating case differences (UE type names
  // do not collide on case). Returns the symbol or null.
  getClassLike(name) {
    const bare = normalizeSymbolName(name);
    return this.classLikeByName.get(bare) || this.classLikeByLowerName.get(bare.toLowerCase()) || null;
  }

  addSimpleSymbols(kind, source) {
    for (const [name, raw] of Object.entries(source || {})) {
      let summary = '';
      if (kind === 'offset') {
        summary = formatOffset(raw);
      } else if (kind === 'enum') {
        const info = extractEnum(raw);
        summary = `${info.values.length} values${info.underlying ? ` : ${info.underlying}` : ''}`;
      }
      this.addSymbol({
        id: `${kind}:${name}`,
        kind,
        name,
        summary,
        raw
      });
    }
  }

  addSymbol(symbol) {
    this.symbols.push(symbol);
    this.symbolById.set(symbol.id, symbol);
  }

  getFunctionEntries() {
    const entries = [];
    for (const [ownerOrName, value] of Object.entries(this.data.functions || {})) {
      if (Array.isArray(value)) {
        // Dumpspace export shape: owner -> [ { functionName: definition }, ... ].
        for (const item of value) {
          if (item && typeof item === 'object' && !Array.isArray(item)) {
            for (const [name, raw] of Object.entries(item)) {
              entries.push({ owner: ownerOrName, name, raw });
            }
          }
        }
      } else if (value && typeof value === 'object') {
        // Native/direct shape: owner -> { functionName: definition }.
        for (const [name, raw] of Object.entries(value)) {
          entries.push({ owner: ownerOrName, name, raw });
        }
      } else {
        entries.push({ owner: null, name: ownerOrName, raw: value });
      }
    }
    return entries;
  }

  searchSymbols(options = {}) {
    const parsed = parseFieldFilters(options.query || '*');
    const requestedKinds = new Set(options.kinds || []);
    const query = parsed.query;
    const filters = { ...parsed.filters, ...(options.filters || {}) };

    const items = this.symbols
      .filter((symbol) => requestedKinds.size === 0 || requestedKinds.has(symbol.kind))
      .filter((symbol) => !filters.kind || matchesQuery(symbol.kind, filters.kind, options))
      .filter((symbol) => !filters.inherits || this.inheritsFrom(symbol.name, filters.inherits))
      .filter((symbol) => !filters.assignableTo || this.isAssignableTo(symbol.name, filters.assignableTo))
      .filter((symbol) => matchesQuery(symbol.name, query, options))
      .map((symbol) => compactSymbol(symbol));

    const result = paginate(items, options, this);
    this.eventBus.emit('search:completed', { type: 'symbols', query: options.query || '*', count: items.length });
    return result;
  }

  searchMembers(options = {}) {
    const owner = options.owner || options.symbolId;
    const symbol = this.getClassLike(owner);
    if (!symbol) {
      const result = emptyPage(options, this);
      result.searched = { classes: [], totalMembers: 0, note: `class/struct '${owner}' not found` };
      return result;
    }
    const ownerName = symbol.name;

    const searchFields = new Set(options.searchFields || ['name']);
    const owners = options.includeInherited
      ? [...this.getInheritancePath(ownerName)].reverse()
      : [ownerName];

    const searchedClasses = [];
    let totalMembers = 0;
    const items = [];
    for (const currentOwner of owners) {
      const current = this.classLikeByName.get(currentOwner);
      if (!current) {
        continue;
      }
      searchedClasses.push(currentOwner);

      for (const member of extractMembers(current.raw)) {
        totalMembers += 1;
        const values = [];
        if (searchFields.has('name')) values.push(member.name);
        if (searchFields.has('type')) values.push(member.type);
        if (values.some((value) => matchesQuery(value, options.query || '*', options))) {
          const item = {
            id: `${current.kind}:${current.name}:member:${member.name}`,
            kind: 'member',
            owner: current.name,
            name: member.name,
            type: member.type,
            offset: member.offset,
            offsetHex: formatOffset(member.offset),
            size: member.size
          };
          if (options.raw) {
            item.raw = member.raw;
          }
          items.push(item);
        }
      }
    }

    const result = paginate(items, options, this);
    // Diagnostics: which classes were scanned and how many members exist there.
    // Especially useful to understand an empty result with includeInherited.
    result.searched = { classes: searchedClasses, totalMembers };
    return result;
  }

  // Resolve many "ClassName::MemberName" queries to offsets in one call.
  // Falls back to a same-named function (returning its address) when no member
  // matches, and reports which classes were searched when nothing is found.
  resolveOffsets(options = {}) {
    const queries = Array.isArray(options.queries) ? options.queries : [];
    const includeInherited = options.includeInherited !== false; // default true
    const includeRaw = !!options.raw;

    const results = queries.map((q) => this.resolveOneOffset(q, includeInherited, includeRaw));
    const found = results.filter((r) => r.found).length;
    return { total: results.length, found, missing: results.length - found, results };
  }

  resolveOneOffset(query, includeInherited, includeRaw) {
    const raw = String(query);
    const idx = raw.lastIndexOf('::');
    if (idx === -1) {
      return { query: raw, found: false, reason: "expected 'ClassName::MemberName'" };
    }

    const requestedClass = raw.slice(0, idx).trim();
    const memberName = raw.slice(idx + 2).trim();
    const symbol = this.getClassLike(requestedClass);
    if (!symbol) {
      return { query: raw, found: false, reason: `class/struct '${requestedClass}' not found` };
    }

    const className = symbol.name;
    const owners = includeInherited ? this.getInheritancePath(className) : [className];
    let membersScanned = 0;
    const candidateNames = [];

    // Prefer a member (most-derived class first).
    for (const currentOwner of owners) {
      const current = this.classLikeByName.get(currentOwner);
      if (!current) continue;
      const members = extractMembers(current.raw);
      membersScanned += members.length;
      for (const m of members) candidateNames.push(m.name);
      const member =
        members.find((m) => m.name === memberName) ||
        members.find((m) => m.name.toLowerCase() === memberName.toLowerCase());
      if (member) {
        const out = {
          query: raw,
          found: true,
          kind: 'member',
          class: currentOwner,
          member: member.name,
          type: member.type,
          offset: member.offset,
          offsetHex: formatOffset(member.offset),
          size: member.size
        };
        if (includeRaw) out.raw = member.raw;
        return out;
      }
    }

    // Fall back to a same-named function on any searched class.
    for (const currentOwner of owners) {
      const fnSymbol = this.symbolById.get(`function:${currentOwner}::${memberName}`);
      if (fnSymbol) {
        const info = extractFunction(fnSymbol.raw);
        const out = {
          query: raw,
          found: true,
          kind: 'function',
          class: currentOwner,
          member: memberName,
          address: info ? info.address : null,
          addressHex: info && info.address != null ? formatOffset(info.address) : null,
          signature: info ? formatFunctionSignature(memberName, info) : memberName
        };
        if (includeRaw) out.raw = fnSymbol.raw;
        return out;
      }
    }

    // Miss: offer the closest real names (members + functions) across the
    // searched classes, so a typo or case mismatch surfaces the right name
    // instead of forcing the caller to grep the raw dump.
    for (const currentOwner of owners) {
      const fnNames = this.functionNamesByOwner.get(currentOwner);
      if (fnNames) candidateNames.push(...fnNames);
    }
    const suggestions = suggestNames(memberName, candidateNames);

    return { query: raw, found: false, reason: 'member/function not found', searchedClasses: owners, membersScanned, suggestions };
  }

  getSymbolDetail(options = {}) {
    const symbol = this.resolveSymbol(options.symbolId || options.name);
    if (!symbol) {
      return { found: false };
    }

    const detail = {
      found: true,
      ...compactSymbol(symbol),
      parent: symbol.parent || null,
      children: this.childrenByName.get(symbol.name) || [],
      inheritancePath: this.getInheritancePath(symbol.name)
    };

    // Raw JSON entry as stored in the dump (e.g. the array-of-tuples member
    // format), for callers that need the exact shape.
    if (options.raw) {
      detail.raw = symbol.raw;
    }

    if (symbol.kind === 'class' || symbol.kind === 'struct') {
      const size = extractClassSize(symbol.raw);
      detail.size = size;
      detail.sizeHex = size != null ? formatOffset(size) : null;
      detail.memberCount = extractMembers(symbol.raw).length;

      if (options.includeMembers) {
        // Pass memberLimit through untouched; paginate() normalizes it once
        // (0 => all). Pre-normalizing here would double-normalize Infinity.
        detail.members = this.searchMembers({
          owner: symbol.name,
          query: '*',
          limit: options.memberLimit
        }).items;
      }
    } else if (symbol.kind === 'enum') {
      const info = extractEnum(symbol.raw);
      detail.underlyingType = info.underlying;
      detail.valueCount = info.values.length;
      detail.values = info.values;
    } else if (symbol.kind === 'function') {
      const info = extractFunction(symbol.raw);
      if (info) {
        detail.returnType = info.returnType;
        detail.parameters = info.params;
        detail.address = info.address;
        detail.addressHex = info.address != null ? formatOffset(info.address) : null;
        detail.flags = info.flags;
        detail.signature = formatFunctionSignature(symbol.name, info);
      }
    } else if (symbol.kind === 'offset') {
      const value = typeof symbol.raw === 'number' ? symbol.raw : Number(symbol.raw);
      detail.value = Number.isFinite(value) ? value : symbol.raw;
      detail.valueHex = Number.isFinite(value) ? formatOffset(value) : null;
    }

    return detail;
  }

  explainTypeRelationship(options = {}) {
    const from = normalizeTypeName(options.from);
    const to = normalizeTypeName(options.to);

    if (!from || !to) {
      return { compatible: false, relationship: 'unknown', path: [] };
    }

    if (from === to) {
      return { compatible: true, relationship: 'same-type', path: [from] };
    }

    const fromPath = this.getInheritancePath(from);
    const toPath = this.getInheritancePath(to);

    if (fromPath.includes(to)) {
      return {
        compatible: true,
        relationship: 'derived-to-base',
        path: fromPath.slice(0, fromPath.indexOf(to) + 1),
        castDirection: 'upcast'
      };
    }

    if (toPath.includes(from)) {
      return {
        compatible: true,
        relationship: 'base-to-derived',
        path: toPath.slice(0, toPath.indexOf(from) + 1),
        castDirection: 'downcast'
      };
    }

    return { compatible: false, relationship: 'unrelated', path: [] };
  }

  resolveSymbol(idOrName) {
    if (!idOrName) {
      return null;
    }
    const bareName = normalizeSymbolName(idOrName);
    return (
      this.symbolById.get(idOrName) ||
      this.classLikeByName.get(bareName) ||
      this.symbolByName.get(bareName) ||
      this.symbolByName.get(idOrName) ||
      this.classLikeByLowerName.get(bareName.toLowerCase()) ||
      null
    );
  }

  getInheritancePath(name) {
    const pathItems = [];
    let current = normalizeTypeName(name);
    const seen = new Set();

    while (current && !seen.has(current)) {
      seen.add(current);
      pathItems.push(current);
      const symbol = this.classLikeByName.get(current);
      current = symbol ? symbol.parent : null;
    }

    return pathItems;
  }

  inheritsFrom(name, baseName) {
    return this.getInheritancePath(name).slice(1).some((item) => matchesQuery(item, baseName));
  }

  isAssignableTo(name, targetName) {
    return this.explainTypeRelationship({ from: name, to: targetName }).compatible;
  }
}

// Dumpspace exports wrap the keyed symbol map inside { data: [...], version, updated_at }.
// The array holds one entry per symbol, in one of two shapes:
//   - { SymbolName: rawDefinition }   (Classes/Structs/Functions/Enums)
//   - [ "OFFSET_NAME", value ]        (Offsets)
// The viewer's native format is already a direct keyed object, so pass that through unchanged.
function normalizeDumpJson(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return parsed && typeof parsed === 'object' ? parsed : {};
  }

  const isWrapper =
    Array.isArray(parsed.data) &&
    ('version' in parsed || 'updated_at' in parsed || 'credit' in parsed);

  if (!isWrapper) {
    return parsed;
  }

  const result = {};
  for (const entry of parsed.data) {
    if (Array.isArray(entry)) {
      // [name, value] pair form (OffsetsInfo).
      if (typeof entry[0] === 'string') {
        result[entry[0]] = entry.length >= 2 ? entry[1] : null;
      }
    } else if (entry && typeof entry === 'object') {
      // { symbolName: rawDefinition } single-key object form.
      Object.assign(result, entry);
    }
  }

  return result;
}

function extractMembers(raw) {
  const members = [];
  if (!Array.isArray(raw)) {
    return members;
  }

  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      continue;
    }

    for (const [name, value] of Object.entries(item)) {
      if (name === '__InheritInfo' || name === '__MDKClassSize') {
        continue;
      }

      if (Array.isArray(value) && value.length >= 2) {
        members.push({
          name,
          typeInfo: value[0],
          type: formatType(value[0]),
          offset: value[1],
          size: value[2] || 0,
          raw: value
        });
      }
    }
  }

  return members.sort((a, b) => a.offset - b.offset || a.name.localeCompare(b.name));
}

function extractParent(raw) {
  if (!Array.isArray(raw)) {
    return null;
  }

  for (const item of raw) {
    if (item && typeof item === 'object' && Object.prototype.hasOwnProperty.call(item, '__InheritInfo')) {
      const inheritInfo = item.__InheritInfo;
      if (Array.isArray(inheritInfo)) {
        // __InheritInfo is the full ancestor chain ordered direct-parent-first
        // (e.g. ACharacter -> ["APawn", "AActor", "UObject"]), so the direct
        // parent is the FIRST element, not the last.
        return inheritInfo[0] || null;
      }
      return inheritInfo || null;
    }
  }

  return null;
}

// Rank candidate names by closeness to a query: exact case-insensitive match
// first, then substring overlap, then small edit distance. Used to suggest the
// right name when a resolve_offsets query misses (typo / wrong case).
function suggestNames(query, candidates, limit = 5) {
  const q = String(query).toLowerCase();
  if (!q) return [];
  const maxDistance = Math.max(3, Math.floor(q.length / 2));
  const best = new Map(); // name -> score (lower is better)

  for (const name of candidates) {
    const n = String(name).toLowerCase();
    let score;
    if (n === q) {
      score = 0;
    } else if (n.includes(q) || q.includes(n)) {
      score = 1 + Math.abs(n.length - q.length) / 100;
    } else {
      const distance = levenshtein(q, n);
      if (distance > maxDistance) continue;
      score = 2 + distance;
    }
    if (!best.has(name) || score < best.get(name)) {
      best.set(name, score);
    }
  }

  return [...best.entries()]
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([name]) => name);
}

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  const row = new Array(n + 1);
  for (let j = 0; j <= n; j++) row[j] = j;

  for (let i = 1; i <= m; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= n; j++) {
      const temp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = temp;
    }
  }

  return row[n];
}

// Total instance size of a class/struct, stored as __MDKClassSize.
// Real dumps use a plain number; the test fixture uses [flags, size].
function extractClassSize(raw) {
  if (!Array.isArray(raw)) {
    return null;
  }

  for (const item of raw) {
    if (item && typeof item === 'object' && Object.prototype.hasOwnProperty.call(item, '__MDKClassSize')) {
      const value = item.__MDKClassSize;
      if (Array.isArray(value)) {
        const last = value[value.length - 1];
        return typeof last === 'number' ? last : null;
      }
      return typeof value === 'number' ? value : null;
    }
  }

  return null;
}

// Enum shapes:
//   Dumpspace: [ [ {Name: value}, ... ], "underlyingType" ]
//   fixture:   [ {Name: value}, ... ]
function extractEnum(raw) {
  if (!Array.isArray(raw)) {
    return { values: [], underlying: null };
  }

  let list = raw;
  let underlying = null;
  if (Array.isArray(raw[0])) {
    list = raw[0];
    underlying = typeof raw[1] === 'string' ? raw[1] : null;
  }

  const values = [];
  for (const item of list) {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      for (const [name, value] of Object.entries(item)) {
        values.push({ name, value });
      }
    }
  }

  return { values, underlying };
}

// Function definition shape: [ returnTypeInfo, paramsArray, address, flagsString ].
// Each param is [ typeInfo, directionOrFlag, name ].
function extractFunction(raw) {
  if (!Array.isArray(raw)) {
    return null;
  }

  const [returnInfo, paramsRaw, address, flags] = raw;
  const params = Array.isArray(paramsRaw)
    ? paramsRaw
        .filter((p) => Array.isArray(p))
        .map((p) => ({
          type: formatType(p[0]),
          name: p[2] || '',
          flag: p[1] || ''
        }))
    : [];

  return {
    returnType: formatType(returnInfo),
    params,
    address: typeof address === 'number' ? address : null,
    flags: typeof flags === 'string' ? flags : ''
  };
}

function formatFunctionSignature(name, info) {
  if (!info) {
    return name;
  }
  const args = info.params.map((p) => `${p.type} ${p.name}`.trim()).join(', ');
  return `${info.returnType} ${name}(${args})`;
}

function formatType(typeInfo) {
  if (!Array.isArray(typeInfo) || typeInfo.length === 0) {
    return 'Unknown';
  }

  let formatted = String(typeInfo[0] || 'Unknown');
  if (typeInfo[2] === '*' || typeInfo[1] === '*') {
    formatted += '*';
  }

  if (Array.isArray(typeInfo[3]) && typeInfo[3].length > 0) {
    formatted += `<${typeInfo[3].map(formatType).join(', ')}>`;
  }

  return formatted;
}

function formatOffset(value) {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) {
    return String(value);
  }
  return `0x${number.toString(16)}`;
}

function compactSymbol(symbol) {
  return {
    id: symbol.id,
    kind: symbol.kind,
    name: symbol.name,
    owner: symbol.owner || null,
    summary: symbol.summary || ''
  };
}

function normalizeSymbolName(value) {
  return String(value || '').replace(/^[^:]+:/, '');
}

function normalizeTypeName(value) {
  return normalizeSymbolName(value).replace(/\*+$/, '').trim();
}

function emptyPage(options, defaults) {
  return paginate([], options, defaults);
}

module.exports = {
  DUMP_FILES,
  DumpspaceSession,
  normalizeDumpJson,
  extractMembers,
  extractClassSize,
  extractEnum,
  extractFunction,
  formatFunctionSignature,
  formatType
};
