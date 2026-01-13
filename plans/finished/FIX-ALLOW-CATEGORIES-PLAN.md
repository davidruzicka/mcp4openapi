# Fix MCP4_TOOL_FILTER_ALLOW_CATEGORIES Implementation Plan

## Decisions (Confirmed)

- **Allow rule semantics**: **OR** across allow rules (name list, name regex, categories). This enables a "read-only expansion" mode: the agent can access additional non-enumerated tools if they are detected as `list`/`read`, while still being able to explicitly allow other tools via `ALLOW_NAMES` / `ALLOW_NAME_REGEX`.
- **Safety**: **Fail-safe deny** for category detection. If category cannot be determined (unresolvable operation, invalid call, missing steps), then the tool must **not** match the category allow rule.
- **Scope**: Must be enforced consistently in **both** server paths that apply global tool filtering (stdio server startup via `MCPServer` and HTTP transport path via `HttpTransport`).

## Problem Summary

`MCP4_TOOL_FILTER_ALLOW_CATEGORIES` is parsed and stored in config, but never applied because:
1. `CategoryMatchRule` is not added to `allowRules` in `GlobalToolFilter.buildEngine()`
2. `FilterEngine.evaluate()` only accepts `string` (tool name), but `CategoryMatchRule.matches()` requires `ToolDefinition`
3. `OperationDetector` is not available in `GlobalToolFilter` context

## Goal

Enable `MCP4_TOOL_FILTER_ALLOW_CATEGORIES` to filter tools by operation categories (`list` and/or `read`) as an **additional allow rule** (OR semantics). This supports "read-only expansion": tools not explicitly listed can still be available if they are detected as list/read-only.

## Target Semantics (Precedence)

1. **Deny rules always win**: `DENY_NAMES` / `DENY_NAME_REGEX` deny immediately.
2. If **no allow rules** are configured, allow by default (current behavior).
3. If **any allow rule** matches, allow.
4. If no allow rule matches, deny.

Notes:
- If `ALLOW_CATEGORIES` is configured, it counts as an allow rule.
- With fail-safe deny, category rule matches only when detection is confident and within configured categories.

## Implementation Steps

### Step 1: Extend FilterEngine API
**File**: `src/tool-filter/filter/filter-engine.ts`

**Changes**:
- Add new method `evaluateTool(tool: ToolDefinition): FilterResult` that accepts `ToolDefinition`
- Keep existing `evaluate(toolName: string)` for backward compatibility (used by `SessionToolFilter`)
- Both methods share same logic, but `evaluateTool()` passes `ToolDefinition` to rules
- Preserve existing Unicode NFC normalization behavior for name-based rules (see Step 1b)

**Implementation**:
```typescript
/**
 * Evaluate tool definition against rules
 * 
 * Used when rules need full tool definition (e.g., CategoryMatchRule)
 */
evaluateTool(tool: ToolDefinition): FilterResult {
  // Check deny rules first (precedence)
  for (const rule of this.denyRules) {
    if (rule.matches(tool)) {
      return FilterResult.denied(rule.getReason());
    }
  }

  // If no allow rules, allow by default
  if (this.allowRules.length === 0) {
    return FilterResult.allowed();
  }

  // Check allow rules
  for (const rule of this.allowRules) {
    if (rule.matches(tool)) {
      return FilterResult.allowed(rule.getReason());
    }
  }

  // No allow rule matched
  return FilterResult.denied('no_allow_match');
}
```

**Tests**: Add tests in `src/tool-filter/filter/filter-engine.test.ts`:
- Test `evaluateTool()` with `CategoryMatchRule`
- Test `evaluateTool()` with mixed rules (ExactMatchRule + CategoryMatchRule)
- Test backward compatibility of `evaluate()` method

### Step 1b: Preserve NFC Normalization (No Behavior Regression)
**Files**:
- `src/tool-filter/filter/filter-rules.ts` (preferred)
  - Ensure `ExactMatchRule` and `RegexMatchRule` normalize the compared tool name to NFC, regardless of whether they receive a string or a `ToolDefinition`.
  - This keeps behavior consistent between `evaluate(toolName)` (which currently normalizes) and `evaluateTool(tool)` (which would otherwise pass raw `tool.name`).

**Test additions**:
- Add a small unit test ensuring a non-ASCII tool name with NFC/NFD differences matches consistently in both evaluation paths.

---

### Step 2: Update GlobalToolFilter Constructor
**File**: `src/tool-filter/filter/global-tool-filter.ts`

**Changes**:
- Add optional `OperationDetector` parameter to constructor
- Store detector as private field
- Use detector in `buildEngine()` to create `CategoryMatchRule` when `allowCategories` is set
- If `allowCategories` is set but detector is missing, **throw** a configuration error (do not silently degrade). This prevents users from believing categories are enforced when they are not.

**Implementation**:
```typescript
export class GlobalToolFilter {
  private engine: FilterEngine;

  constructor(
    private config: ToolFilterConfig,
    private logger: Logger,
    private detector?: OperationDetector  // Optional - only needed for categories
  ) {
    this.engine = this.buildEngine(config);
  }

  private buildEngine(config: ToolFilterConfig): FilterEngine {
    const allowRules = [];
    const denyRules = [];

    // Build allow rules
    if (config.allowList.size > 0) {
      allowRules.push(new ExactMatchRule(config.allowList, 'allow'));
    }

    if (config.allowRegex.length > 0) {
      allowRules.push(new RegexMatchRule(config.allowRegex, 'allow'));
    }

    // Add CategoryMatchRule if categories configured and detector available
    if (config.allowCategories.size > 0 && this.detector) {
      allowRules.push(new CategoryMatchRule(config.allowCategories, this.detector));
    }

    // Build deny rules
    if (config.denyList.size > 0) {
      denyRules.push(new ExactMatchRule(config.denyList, 'deny'));
    }

    if (config.denyRegex.length > 0) {
      denyRules.push(new RegexMatchRule(config.denyRegex, 'deny'));
    }

    return new FilterEngine(allowRules, denyRules);
  }
}
```

**Tests**: Update `src/tool-filter/filter/global-tool-filter.test.ts`:
- Test with `allowCategories` and `OperationDetector` provided
- Test with `allowCategories` but no `OperationDetector` (should throw)
- Test category filtering with list-only tools
- Test category filtering with read-only tools
- Test category filtering with composite tools

---

### Step 3: Update GlobalToolFilter.apply() Method
**File**: `src/tool-filter/filter/global-tool-filter.ts`

**Changes**:
- Change `engine.evaluate(tool.name)` to `engine.evaluateTool(tool)` to pass full `ToolDefinition`
- This enables `CategoryMatchRule` to access tool operations

**Implementation**:
```typescript
apply(tools: ToolDefinition[]): GlobalToolFilterResult {
  const allowed: ToolDefinition[] = [];
  const removed: ToolDefinition[] = [];
  const reasons = new Map<string, string[]>();

  for (const tool of tools) {
    const result = this.engine.evaluateTool(tool);  // Changed from evaluate(tool.name)

    if (result.allowed) {
      allowed.push(tool);
    } else {
      removed.push(tool);
      if (result.reason) {
        reasons.set(tool.name, [result.reason]);
      }
      this.logFiltered(tool, result.reason);
    }
  }

  return {
    allowed,
    removed,
    reasons,
    summary: {
      originalCount: tools.length,
      allowedCount: allowed.length,
      removedCount: removed.length
    }
  };
}
```

**Tests**: Existing tests should pass (they use `ExactMatchRule` and `RegexMatchRule` which work with both string and ToolDefinition)

---

### Step 4: Create OperationDetector in ToolFilterService
**File**: `src/tool-filter/integration/tool-filter-service.ts`

**Changes**:
- Add optional `OperationDetector` parameter to constructor
- Pass detector to `GlobalToolFilter` constructor
- Create detector in `MCPServer` and in `HttpTransport` and pass to service

**Implementation**:
```typescript
export class ToolFilterService {
  constructor(
    private envParser: EnvConfigParser,
    private headerParser: HeaderConfigParser,
    private logger: Logger,
    private detector?: OperationDetector  // Optional - only needed for categories
  ) {}

  applyGlobalFilter(
    tools: ToolDefinition[],
    env: NodeJS.ProcessEnv
  ): ToolDefinition[] {
    const config = this.envParser.parse(env);
    
    if (!config) {
      return tools;
    }

    const filter = new GlobalToolFilter(config, this.logger, this.detector);
    const result = filter.apply(tools);

    this.logger.info('Global tool filter applied', {
      original: result.summary.originalCount,
      allowed: result.summary.allowedCount,
      removed: result.summary.removedCount
    });

    return result.allowed;
  }
}
```

**Tests**: Update `src/tool-filter/integration/tool-filter-service.test.ts`:
- Test with `OperationDetector` provided
- Test category filtering through service layer

---

### Step 5: Wire OperationDetector in MCPServer
**File**: `src/mcp-server.ts`

**Changes**:
- Create `OperationDetector` in `applyGlobalToolFiltering()` method
- Pass detector to `ToolFilterService` constructor
- Reuse existing `buildToolFilterResolver()` for `OperationResolver`

**Implementation**:
```typescript
private applyGlobalToolFiltering(): void {
  if (!this.profile) {
    return;
  }

  // Initialize ToolFilterService if not already done
  if (!this.toolFilterService) {
    const validator = new RegexValidator();
    const compiler = new RegexCompiler(validator);
    const envParser = new EnvConfigParser(compiler);
    const headerParser = new HeaderConfigParser(compiler);
    
    // Create OperationDetector for category filtering
    const classifier = new OperationClassifier();
    const resolver = new OpenAPIOperationResolver(this.parser);
    const detector = new OperationDetector(classifier, resolver);
    
    this.toolFilterService = new ToolFilterService(
      envParser,
      headerParser,
      this.logger,
      detector
    );
  }

  // ... rest of method unchanged
}
```

**Imports needed**:
```typescript
import { OperationClassifier } from './tool-filter/operation/operation-classifier.js';
import { OpenAPIOperationResolver } from './tool-filter/operation/operation-resolver.js';
import { OperationDetector } from './tool-filter/operation/operation-detector.js';
```

**Tests**: Update `src/mcp-server.test.ts`:
- Test that `allowCategories` filtering works end-to-end
- Test that tools with modify operations are filtered out
- Test that composite tools are filtered correctly

### Step 5b: Wire OperationDetector in HttpTransport
**File**: `src/http-transport.ts`

**Why**: HTTP transport also lazily initializes `ToolFilterService`. Category filtering must behave the same as stdio startup.

**Changes**:
- Create `OperationDetector` using the same components (`OperationClassifier`, `OpenAPIOperationResolver` or equivalent resolver based on the already-loaded `OpenAPIParser` instance used by transport).
- Pass the detector into `ToolFilterService` so `GlobalToolFilter` can enforce `ALLOW_CATEGORIES`.

**Tests**:
- Extend or add an HTTP-transport focused test that sets `MCP4_TOOL_FILTER_ALLOW_CATEGORIES` and verifies that only list/read tools are exposed after initialization.

---

### Step 6: Add Integration Tests
**File**: `src/tool-filter/integration/tool-filter-service.test.ts` (or new test file)

**Tests to add**:
1. **Category filtering - list only**:
   - Tools with `list` operations → allowed
   - Tools with `read` operations → denied
   - Tools with `modify` operations → denied

2. **Category filtering - read only**:
   - Tools with `read` operations → allowed
   - Tools with `list` operations → denied
   - Tools with `modify` operations → denied

3. **Category filtering - list+read**:
   - Tools with `list` operations → allowed
   - Tools with `read` operations → allowed
   - Tools with both `list` and `read` → allowed
   - Tools with `modify` operations → denied

4. **Composite tools**:
   - Composite with all steps `list` → allowed (if `list` allowed)
   - Composite with all steps `read` → allowed (if `read` allowed)
   - Composite with mixed `list`+`read` → allowed (if both allowed)
   - Composite with any `modify` step → denied

5. **Combined rules**:
   - `allowCategories=list` + `allowList=[specific_tool]` → both work
   - `allowCategories=list` + `denyList=[specific_list_tool]` → deny takes precedence

---

### Step 7: Update Documentation
**File**: `README.md`

**Changes**:
- Verify that `MCP4_TOOL_FILTER_ALLOW_CATEGORIES` documentation is accurate
- Add example showing category filtering in action
- Update troubleshooting section if needed

**File**: `env.example`

**Changes**:
- Verify comment for `MCP4_TOOL_FILTER_ALLOW_CATEGORIES` is clear

---

## Testing Strategy

### Unit Tests
1. `FilterEngine.evaluateTool()` - test with all rule types
2. `GlobalToolFilter.buildEngine()` - test `CategoryMatchRule` creation
3. `GlobalToolFilter.apply()` - test category filtering
4. `ToolFilterService.applyGlobalFilter()` - test through service layer

### Integration Tests
1. End-to-end: `MCPServer` with `allowCategories` env var
2. Real OpenAPI spec with various operation types
3. Composite tools with category filtering

### Edge Cases
1. Empty `allowCategories` (should not add rule)
2. `allowCategories` without `OperationDetector` (should skip, log warning?)
3. Tool with no operations (should be denied if categories required)
4. Tool with operations that can't be resolved (should be denied if categories required)

---

## Backward Compatibility

- `FilterEngine.evaluate(string)` remains unchanged (used by `SessionToolFilter`)
- `GlobalToolFilter` constructor with `OperationDetector` optional (existing code works)
- `ToolFilterService` constructor with `OperationDetector` optional (existing code works)
- If `ALLOW_CATEGORIES` is not set, missing detector is irrelevant. If `ALLOW_CATEGORIES` is set but detector is missing, **fail fast** with a configuration error.

---

## Rollout Plan

1. **Phase 1**: Implement Steps 1-3 (FilterEngine + GlobalToolFilter changes)
   - Test with unit tests
   - Verify backward compatibility

2. **Phase 2**: Implement Steps 4-5 (Service + MCPServer wiring)
   - Test with integration tests
   - Verify end-to-end flow

3. **Phase 3**: Add comprehensive tests (Step 6)
   - Cover all edge cases
   - Test with real profiles

4. **Phase 4**: Update documentation (Step 7)
   - Verify examples work
   - Update changelog

---

## Estimated Effort

- **Step 1**: 1 hour (FilterEngine extension + tests)
- **Step 2**: 1 hour (GlobalToolFilter changes + tests)
- **Step 3**: 30 minutes (apply() method update)
- **Step 4**: 30 minutes (ToolFilterService changes)
- **Step 5**: 30 minutes (MCPServer wiring)
- **Step 6**: 2 hours (comprehensive tests)
- **Step 7**: 30 minutes (documentation)

**Total**: ~6 hours

---

## Success Criteria

1. ✅ `MCP4_TOOL_FILTER_ALLOW_CATEGORIES=list` filters out tools with modify operations
2. ✅ `MCP4_TOOL_FILTER_ALLOW_CATEGORIES=read` filters out tools with list/modify operations
3. ✅ `MCP4_TOOL_FILTER_ALLOW_CATEGORIES=list,read` allows tools with list and/or read operations
4. ✅ Composite tools are filtered correctly (all steps must match)
5. ✅ No breaking changes to existing filtering functionality
6. ✅ All tests pass
7. ✅ Documentation updated

---

## Notes

- `SessionToolFilter` does NOT support categories (by design - header-based filtering is simpler)
- If `OperationDetector` is not available, category filtering is silently skipped (no error)
- Consider adding warning log if `allowCategories` is set but `OperationDetector` not provided
