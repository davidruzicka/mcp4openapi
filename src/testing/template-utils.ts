import { randomUUID } from 'crypto';

/**
 * Process string templates in values
 *
 * Supports:
 * - Generators: {{$randomInt(min, max)}}, {{$uuid}}, {{$timestamp}}
 * - Context variables: {{varName}}
 * - Type preservation: If the whole string is a template returning a number, returns a number.
 */
export function processTemplate(value: any, context: Record<string, any> = {}): any {
  if (typeof value === 'string') {
    // 1. Exact match checks (to preserve types)
    const fullMatch = value.match(/^\{\{([^}]+)\}\}$/);
    if (fullMatch) {
      const expr = fullMatch[1].trim();

      // Generators
      if (expr.startsWith('$randomInt')) {
        const paramsMatch = expr.match(/^\$randomInt\(\s*(\d+)\s*,\s*(\d+)\s*\)$/);
        if (paramsMatch) {
          const min = parseInt(paramsMatch[1], 10);
          const max = parseInt(paramsMatch[2], 10);
          return Math.floor(Math.random() * (max - min + 1)) + min;
        }
      }

      if (expr === '$uuid') return randomUUID();
      if (expr === '$timestamp') return Date.now();

      // Context variables
      if (expr in context) return context[expr];
    }

    // 2. String interpolation
    if (value.includes('{{')) {
      return value.replace(/\{\{([^}]+)\}\}/g, (match, expression) => {
        const expr = expression.trim();

        if (expr.startsWith('$randomInt')) {
            const paramsMatch = expr.match(/^\$randomInt\(\s*(\d+)\s*,\s*(\d+)\s*\)$/);
            if (paramsMatch) {
                const min = parseInt(paramsMatch[1], 10);
                const max = parseInt(paramsMatch[2], 10);
                return (Math.floor(Math.random() * (max - min + 1)) + min).toString();
            }
        }

        if (expr === '$uuid') return randomUUID();
        if (expr === '$timestamp') return Date.now().toString();

        if (expr in context) {
            const val = context[expr];
            if (typeof val === 'object') return JSON.stringify(val);
            return String(val);
        }

        return match;
      });
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(item => processTemplate(item, context));
  }

  if (typeof value === 'object' && value !== null) {
    const result: any = {};
    for (const key in value) {
        result[key] = processTemplate(value[key], context);
    }
    return result;
  }

  return value;
}
