/**
 * Safe template rendering for admin-authored content (custom commands,
 * welcome messages, embed templates).
 *
 * This is deliberately NOT a general-purpose template engine:
 *  - only `{{name}}` / `{{a.b}}` variable references;
 *  - no loops, no conditionals, no function access, no code evaluation —
 *    a template can never execute arbitrary code;
 *  - unknown variables render as '' (or the literal placeholder when
 *    `missing: 'keep'`), so templates cannot crash or leak internals.
 */

const VAR_RE = /\{\{\s*([a-zA-Z0-9_][a-zA-Z0-9_.]*)\s*\}\}/g;

export interface RenderOptions {
  /** Escape Discord markdown syntax so rendered text is inserted verbatim. */
  escape?: boolean;
  /** How to treat variables that are not present in the context. */
  missing?: 'empty' | 'keep';
}

export function renderTemplate(
  template: string,
  vars: Record<string, unknown>,
  options: RenderOptions = {}
): string {
  const { escape = false, missing = 'empty' } = options;
  const rendered = template.replace(VAR_RE, (match, name: string) => {
    const value = lookup(name, vars);
    if (value === undefined || value === null) {
      return missing === 'keep' ? match : '';
    }
    return typeof value === 'string' ? value : String(value);
  });
  // With `escape`, the WHOLE rendered output is markdown-free — both the
  // template's own syntax and any substituted values. Callers that need
  // markdown from the template but escaped values can apply
  // escapeDiscordMarkdown to individual values before rendering.
  return escape ? escapeDiscordMarkdown(rendered) : rendered;
}

function lookup(name: string, vars: Record<string, unknown>): unknown {
  const parts = name.split('.');
  let current: unknown = vars;
  for (const part of parts) {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

const MD_RE = /(\*|_|~|`|\[|\]|\(|\)|>|#|<@!?)|(?<!:)([a-zA-Z0-9+/=_-]+:\/{2})/g;

/** Minimal Discord-markdown escaper for user/admin-supplied text. */
export function escapeDiscordMarkdown(text: string): string {
  return text.replace(MD_RE, (match, md?: string, url?: string) => {
    if (md) return `\\${md}`;
    if (url) return `\\<${match}`;
    return match;
  });
}
