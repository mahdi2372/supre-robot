import { describe, expect, it } from 'vitest';
import { renderTemplate, escapeDiscordMarkdown } from '../src/utils/templating.js';

describe('renderTemplate', () => {
  it('replaces simple variables', () => {
    expect(renderTemplate('Hello {{name}}!', { name: 'World' })).toBe('Hello World!');
  });

  it('replaces dotted paths', () => {
    expect(renderTemplate('{{a.b}}', { a: { b: 42 } })).toBe('42');
  });

  it('renders unknown variables as empty by default', () => {
    expect(renderTemplate('x={{missing}}y', {})).toBe('x=y');
  });

  it('keeps unknown variables when missing=keep', () => {
    expect(renderTemplate('x={{missing}}y', {}, { missing: 'keep' })).toBe('x={{missing}}y');
  });

  it('escapes discord markdown when requested', () => {
    expect(renderTemplate('**{{v}}**', { v: 'a_b*c' }, { escape: true })).toBe('\\*\\*a\\_b\\*c\\*\\*');
  });

  it('cannot execute anything from the template (no code eval surface)', () => {
    // Variable names are restricted to [a-zA-Z0-9_.] — call syntax cannot appear.
    expect(renderTemplate('{{x()}}', { x: () => 'pwned' })).toBe('{{x()}}');
    // Dotted paths are data lookups only — missing chains render empty.
    expect(renderTemplate('{{constructor.constructor}}', {})).toBe('');
    // Values are stringified as data, never invoked.
    expect(renderTemplate('{{fn}}', { fn: 'plain-string' })).toBe('plain-string');
  });

  it('does not throw on deeply nested lookups; arrays are intentionally opaque', () => {
    expect(renderTemplate('{{a.b.c}}', { a: { b: ['x'] } })).toBe('');
    expect(renderTemplate('{{list.0}}', { list: ['first', 'second'] })).toBe('');
  });

  it('truncates nothing but keeps numbers/booleans stringified', () => {
    expect(renderTemplate('{{n}}/{{b}}', { n: 5, b: false })).toBe('5/false');
  });
});

describe('escapeDiscordMarkdown', () => {
  it('escapes markdown symbols', () => {
    expect(escapeDiscordMarkdown('**bold** _it_ `code`')).toBe('\\*\\*bold\\*\\* \\_it\\_ `code`'.replace('`code`', '\\`code\\`'));
  });

  it('leaves plain text alone', () => {
    expect(escapeDiscordMarkdown('hello world 123')).toBe('hello world 123');
  });
});
