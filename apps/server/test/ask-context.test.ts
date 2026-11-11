import { describe, expect, it } from 'vitest';
import { ASK_CONTEXT_MAX, ASK_STYLE_HINT, AskContext } from '../src/tasks/runner';

const text = (t: string, parent: string | null = null) => ({ type: 'assistant', parent_tool_use_id: parent, message: { content: [{ type: 'text', text: t }] } });
const ask = (id: string, parent: string | null = null) => ({ type: 'assistant', parent_tool_use_id: parent, message: { content: [{ type: 'tool_use', id, name: 'AskUserQuestion', input: {} }] } });
const tool = (id: string, name = 'Read') => ({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id, name, input: {} }] } });

describe('AskContext: the draft Claude wrote before a question', () => {
  it('gives each question the text since the previous question, per thread', () => {
    const c = new AskContext();
    c.see(text('Bản nháp Layout'));
    c.see(tool('r1')); // other tools between the draft and the question keep the draft
    c.see(text('Thêm một ý'));
    c.see(ask('q1'));
    expect(c.take('q1')).toBe('Bản nháp Layout\n\nThêm một ý');
    expect(c.take('q1')).toBeUndefined(); // taken once

    c.see(ask('q2')); // asked again without writing anything
    expect(c.take('q2')).toBe('');

    c.see(text('Nháp của subagent', 'agent-tool-1'));
    c.see(text('Nháp main'));
    c.see(ask('q3', 'agent-tool-1'));
    c.see(ask('q4'));
    expect(c.take('q3')).toBe('Nháp của subagent');
    expect(c.take('q4')).toBe('Nháp main');

    expect(c.take('unknown')).toBeUndefined();
    expect(c.take(null)).toBeUndefined();
    c.see({ type: 'user', message: { content: 'x' } }); // ignored
  });

  it('keeps only the end of a long text', () => {
    const c = new AskContext();
    c.see(text('a'.repeat(ASK_CONTEXT_MAX) + 'END'));
    c.see(ask('q'));
    const t = c.take('q')!;
    expect(t).toHaveLength(ASK_CONTEXT_MAX);
    expect(t.endsWith('END')).toBe(true);
  });

  it('the system prompt asks for the draft first and short questions', () => {
    expect(ASK_STYLE_HINT).toMatch(/write that content in full in a normal message first/);
    expect(ASK_STYLE_HINT).toMatch(/one or two short sentences/);
  });
});
